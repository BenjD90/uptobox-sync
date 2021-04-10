import { MongoClient } from '@neo9/n9-mongo-client';
import { N9Log } from '@neo9/n9-node-log';
import { N9Error, waitFor } from '@neo9/n9-node-utils';
import * as BasicFTP from 'basic-ftp';
import { Client } from 'basic-ftp';
import * as FsExtra from 'fs-extra';
import * as _ from 'lodash';
import * as moment from 'moment';
import { N9NodeRouting } from 'n9-node-routing';
import * as ProgressStream from 'progress-stream';
import * as PromisePool from 'promise-pool-executor';
import { Inject, Service } from 'typedi';
import { Conf } from '../../conf/index.models';
import { FileEntity } from '../files/files.models';
import { FilesService } from '../files/files.service';
import { Utils } from '../utils.service';
import { SyncEntity } from './sync.models';
import { UptoboxClient } from './uptobox.client';
import * as CliProgress from 'cli-progress';

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
				autopadding: true
			}, CliProgress.Presets.shades_classic);
			const pool = new PromisePool.PromisePoolExecutor({
				concurrencyLimit: this.conf.uptobox.concurrencyLimit,
			});
			let nbFileTreated = 0;
			let nbBytesTreated = 0;
			const globalBar: CliProgress.SingleBar = multibar.create(totalSizeToUpload, 0, {
				filename: `${(nbFileTreated).toLocaleString().padStart(5)} / ${(nbFilesToSync).toLocaleString().padStart(5)} | ${Utils.sizeToGB(nbBytesTreated)} / ${Utils.sizeToGB(totalSizeToUpload)} GB`,
			});

			await allFilesToSync.forEachAsync(async (file: FileEntity) => {
				pool.addSingleTask({
					generator: async () => {
						await this.uploadOneFile(multibar, file);
						globalBar.increment(file.fileSizeByte, {
							filename: `${(nbFileTreated).toLocaleString().padStart(5)} / ${(nbFilesToSync).toLocaleString().padStart(5)} | ${Utils.sizeToGB(nbBytesTreated)} / ${Utils.sizeToGB(totalSizeToUpload)} GB`,
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
		const bar: CliProgress.SingleBar = multibar.create(file.fileSizeByte, 0, {
			filename: `${Utils.sizeToGB(0, 3, 2)} /${Utils.sizeToGB(file.fileSizeByte, 3, 2)} GB | ${file.name.padEnd(90)}`,
		});
		try {
			// check file exist
			const isFileExists = await FsExtra.pathExists(file.fullPath);
			if (!isFileExists) {
				throw new N9Error('file-not-found', 404, { fullPath: file.fullPath });
			}
			let fileCode: string;
			if (this.conf.uptobox.preferredUploadType === 'ftp') {
				try {
					fileCode = await this.uploadViaFTP(file.fullPath, file.name, file.fileSizeByte, (progress: ProgressStream.Progress) => {
						this.onPartOnFileUploaded('FTP ', progress, bar, file.name);
					});
				} catch (e) {
					this.logger.error(`Error while sending file through FTP, retrying through HTTP`, { e, eString: JSON.stringify(e) });
					fileCode = await this.uptoboxClient.uploadViaHTTP(file.fullPath, file.name, file.fileSizeByte, (progress: ProgressStream.Progress) => {
						this.onPartOnFileUploaded('HTTP', progress, bar, file.name);
					});
				}
			} else {
				try {
					fileCode = await this.uptoboxClient.uploadViaHTTP(file.fullPath, file.name, file.fileSizeByte, (progress: ProgressStream.Progress) => {
						this.onPartOnFileUploaded('HTTP', progress, bar, file.name);
					});
				} catch (e) {
					this.logger.error(`Error while sending file through HTTP, retrying through FTP`, { e, eString: JSON.stringify(e) });
					fileCode = await this.uploadViaFTP(file.fullPath, file.name, file.fileSizeByte, (progress: ProgressStream.Progress) => {
						this.onPartOnFileUploaded('FTP ', progress, bar, file.name);
					});
				}
			}

			// set file private
			await this.uptoboxClient.setFilePrivate(fileCode);

			// ensure file destination directory exists
			const originalDirectory = this.conf.files.directories.find((directory) => directory.path === file.directoryBasePath);
			const remotePath = originalDirectory.remotePrefix + file.directoryFullPath.replace(new RegExp('^' + _.escapeRegExp(originalDirectory.path)), '');
			const targetFolderId = await this.uptoboxClient.ensureFolder(remotePath);

			// move file
			await this.uptoboxClient.moveFileToTargetFolder(fileCode, targetFolderId);

			await this.filesService.setSynced(file._id, fileCode);

		} catch (e) {
			this.logger.error(`Error while sending file`, e, JSON.stringify(e));
			await this.filesService.saveErrorToFile(file._id, new N9Error(e.name, e.status, e.context));
			this.nbErrors++;
			if (this.nbErrors > 100) {
				this.logger.error(`Nb max errors reached ${this.nbErrors}`);
				throw e;
			}
		}
		multibar.remove(bar);
	}

	private onPartOnFileUploaded(uploadType: 'FTP ' | 'HTTP', progress: ProgressStream.Progress, bar: CliProgress.SingleBar, fileName: string): void {
		const speedInMB = progress.speed / (1_024 * 1_024);
		const speedInMb = (8 * progress.speed) / (1_024 * 1_024);
		const speed = `${Utils.formatMBOrMb(speedInMB)} MB/s | ${Utils.formatMBOrMb(speedInMb)} Mb/s `;
		const volumeState = `${Utils.sizeToGB(progress.transferred, 3, 2)} /${Utils.sizeToGB(progress.length, 3, 2)} GB`;
		bar.increment(progress.delta, {
			filename: `${uploadType} | ${volumeState} | ${speed} | ${fileName.padEnd(90)}`,
		});
	}

	private async uploadViaFTP(fullPath: string, name: string, fileSize: number, onProgress: (update: ProgressStream.Progress) => void): Promise<string> {
		// send ftp
		const ftpClient = new BasicFTP.Client();
		await ftpClient.access(this.conf.uptobox.ftp.auth);
		const ftpClientIndex = this.activeFtpClients.push(ftpClient);
		const progressStream = ProgressStream({
			length: fileSize,
			time: 500, // print every 500 ms
		}).on('progress', (update) => {
			onProgress(update);
		});

		const fileStream = FsExtra.createReadStream(fullPath)
				.pipe(progressStream);

		try {
			await ftpClient.upload(fileStream, name);
		} catch (e) {
			throw e;
		} finally {
			this.activeFtpClients.splice(ftpClientIndex, 1);
			ftpClient.close();
		}

		let fileCode: string;
		const startTime = Date.now();
		do {
			if ((Date.now() - startTime) > (this.conf.uptobox.ftp.waitTimeoutInSec * 1_000)) {
				throw new N9Error('file-not-found-in-uptobox', 404, { name });
			}
			// wait 10s to check file, letting time to uptobox to fetch uploaded file
			await waitFor(this.conf.uptobox.ftp.waitDurationBetweenUploadDoneAndCheckInSec * 1_000);
			// fetch file details from FTP folder
			fileCode = await this.uptoboxClient.getFileIdFromNameInFTPFolder(name);
		} while (!fileCode);
		return fileCode;
	}

	private async endRunningSync(): Promise<void> {
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
