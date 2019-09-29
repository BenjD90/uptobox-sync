import { MongoClient } from '@neo9/n9-mongo-client';
import { N9Log } from '@neo9/n9-node-log';
import { N9Error, waitFor } from '@neo9/n9-node-utils';
import * as BasicFTP from 'basic-ftp';
import { Client } from 'basic-ftp';
// @ts-ignore
import * as CliProgress from 'cli-progress';
import * as FsExtra from 'fs-extra';
import * as _ from 'lodash';
import * as moment from 'moment';
import { N9NodeRouting } from 'n9-node-routing';
import * as PromisePool from 'promise-pool-executor';
import { Inject, Service } from 'typedi';
import { Conf } from '../../conf/index.models';
import { FileEntity } from '../files/files.models';
import { FilesService } from '../files/files.service';
import { Utils } from '../utils.service';
import { SyncEntity } from './sync.models';
import { UptoboxClient } from './uptobox.client';

@Service()
export class SyncService {
	@Inject('conf')
	private conf: Conf;

	@Inject('logger')
	private logger: N9Log;

	private mongoClient: MongoClient<SyncEntity, null>;
	private activeFtpClients: Client[] = [];
	private runningSyncId: string;
	private nbErrors: number = 0;

	constructor(
			@Inject('callbacksBeforeShutdown') private callbacksBeforeShutdown: N9NodeRouting.CallbacksBeforeShutdown[],
			private filesService: FilesService,
			private uptoboxClient: UptoboxClient,
	) {
		this.mongoClient = new MongoClient('syncs', SyncEntity, null, {
			keepHistoric: true,
		});
		this.callbacksBeforeShutdown.push({
			function: this.beforeShutdown,
			thisArg: this,
		});

	}

	public async init(): Promise<void> {
		this.logger.info('init');
	}

	public async startSynchronisation(): Promise<void> {
		if (await this.mongoClient.findOne({ state: 'running' })) {
			throw new N9Error('one-already-running', 400, {});
		}

		(async () => {
			const expireDate = await this.uptoboxClient.getAccountExpireDate();
			if (moment().add(3, 'month').isAfter(expireDate)) {
				this.logger.warn(`Uptobox expiration date is soon !!!!!`, { expireDate });
			}

			this.nbErrors = 0;
			const sync = await this.mongoClient.insertOne({
				state: 'running',
				startDate: new Date(),
			}, 'app');
			this.runningSyncId = sync._id;

			const allFilesToSync = await this.filesService.findAllFilesToSyncAsStream();
			const nbFilesToSync = await this.filesService.countAllFilesToSync();
			const totalSizeToUpload = await this.filesService.sumAllSizesToSync();
			const multibar = new CliProgress.MultiBar({
				clearOnComplete: true,
				hideCursor: true,
				format: `[{bar}] {percentage}%  | {filename} | spent: {duration_formatted} | ETA: {eta_formatted}`,
				etaBuffer: 20,
			}, CliProgress.Presets.shades_classic);
			const pool = new PromisePool.PromisePoolExecutor({
				concurrencyLimit: this.conf.uptobox.concurrencyLimit,
			});
			let nbFileTreated = 0;
			let nbBytesTreated = 0;
			const globalBar: CliProgress.SingleBar = multibar.create(totalSizeToUpload, 0, {
				filename: `${(nbFileTreated).toLocaleString().padStart(5)} / ${(nbFilesToSync).toLocaleString().padStart(5)} | ${Utils.sizeToGo(nbBytesTreated)} / ${Utils.sizeToGo(totalSizeToUpload)} Go`,
			});

			await allFilesToSync.forEachAsync(async (file: FileEntity) => {
				pool.addSingleTask({
					generator: async () => {
						await this.uploadOneFile(multibar, file);
						globalBar.increment(file.fileSizeByte, {
							filename: `${(nbFileTreated).toLocaleString().padStart(5)} / ${(nbFilesToSync).toLocaleString().padStart(5)} | ${Utils.sizeToGo(nbBytesTreated)} / ${Utils.sizeToGo(totalSizeToUpload)} Go`,
						});
						nbFileTreated++;
						nbBytesTreated += file.fileSizeByte;
					},
				});
				while (pool.activeTaskCount >= this.conf.uptobox.poolSize) {
					await waitFor(500);
				}
			});

			await pool.waitForIdle();
			multibar.stop();

			await this.mongoClient.findOneAndUpdateById(sync._id, {
				$set: {
					state: 'end-ok',
					endDate: new Date(),
				},
			}, 'app');
			this.logger.info(`End running synchronisation ${nbFileTreated}/${nbFilesToSync} ${sync._id}`);
		})().catch((e) => {
			this.logger.error(`Error while synchronisation`, e);
		});
	}

	public async beforeShutdown(): Promise<void> {
		this.logger.info(`Close FTP connexion before shutdown`);
		for (const activeFtpClient of this.activeFtpClients) {
			activeFtpClient.close();
		}
		await this.endRunningSync();
	}


	private async uploadOneFile(multibar: CliProgress.MultiBar, file: FileEntity): Promise<void> {
		let nbBytesUploaded = 0;
		const bar: CliProgress.SingleBar = multibar.create(file.fileSizeByte, 0, {
			filename: `${Utils.sizeToGo(nbBytesUploaded, 3, 2)} /${Utils.sizeToGo(file.fileSizeByte, 3, 2)} Go | ${file.name.padEnd(90)}`,
		});
		try {
			// check file exist
			const isFileExists = await FsExtra.pathExists(file.fullPath);
			if (!isFileExists) {
				throw new N9Error('file-not-found', 404, {});
			}
			let fileCode: string;
			if (this.conf.uptobox.uploadType === 'ftp') {
				fileCode = await this.uploadViaFTP(file.fullPath, file.name);
			} else {
				fileCode = await this.uptoboxClient.uploadViaHTTP(file.fullPath, file.name, (delta) => {
					nbBytesUploaded += delta;
					bar.increment(delta, {
						filename: `${Utils.sizeToGo(nbBytesUploaded, 3, 2)} /${Utils.sizeToGo(file.fileSizeByte, 3, 2)} Go | ${file.name.padEnd(90)}`,
					});
				});
			}

			// set file private
			await this.uptoboxClient.setFilePrivate(fileCode);

			// ensure file destination directory exists
			const originalDirectory = this.conf.files.directories.find((directory) => directory.path === file.directoryBasePath);
			const remotePath = originalDirectory.remotePrefix + file.directoryFullPath.replace(new RegExp('^' + _.escapeRegExp(originalDirectory.path)), '');
			const targetFolderId = await this.uptoboxClient.ensureFolder(remotePath);

			// move file
			await this.uptoboxClient.moveFileToTargetFolder(fileCode, targetFolderId);

			await this.filesService.setSynced(file._id);

		} catch (e) {
			this.logger.error(`Error while sending file`, e, JSON.stringify(e));
			await this.filesService.saveErrorToFile(file._id, {
				name: e.name,
				message: e.message,
				context: e.context,
				status: e.status,
			});
			this.nbErrors++;
			if (this.nbErrors > 100) {
				this.logger.error(`Nb max errors reached ${this.nbErrors}`);
				throw e;
			}
		}
		multibar.remove(bar);
	}

	private async uploadViaFTP(fullPath: string, name: string): Promise<string> {
		// send ftp
		const ftpClient = new BasicFTP.Client();
		await ftpClient.access(this.conf.uptobox.ftp.auth);
		const ftpClientIndex = this.activeFtpClients.push(ftpClient);
		await ftpClient.upload(FsExtra.createReadStream(fullPath), name);
		this.activeFtpClients.splice(ftpClientIndex, 1);
		ftpClient.close();
		// fetch file details from FTP folder
		const fileCode = await this.uptoboxClient.getFileIdFromNameInFTPFolder(name);
		return fileCode;
	}

	private async endRunningSync() {
		if (this.runningSyncId) {
			this.logger.info(`End running sync ${this.runningSyncId}`);
			await this.mongoClient.findOneAndUpdateById(this.runningSyncId, {
				$set: {
					state: 'end-killed',
				},
			}, 'app');
		}
	}
}
