import { MongoClient } from '@neo9/n9-mongo-client';
import { N9Log } from '@neo9/n9-node-log';
import { N9Error } from '@neo9/n9-node-utils';
import * as BasicFTP from 'basic-ftp';
import { Client, FileType } from 'basic-ftp';
import * as FsExtra from 'fs-extra';
import * as moment from 'moment';
import { N9NodeRouting } from 'n9-node-routing';
import { Inject, Service } from 'typedi';
import { Conf } from '../../conf/index.models';
import { FilesService } from '../files/files.service';
import { SyncEntity } from './sync.models';
import { UptoboxClient } from './uptobox.client';
import * as _ from 'lodash';

@Service()
export class SyncService {
	@Inject('conf')
	private conf: Conf;

	@Inject('logger')
	private logger: N9Log;

	private mongoClient: MongoClient<SyncEntity, null>;
	private activeFtpClients: Client[] = [];

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

	public async startSync(): Promise<void> {
		if (await this.mongoClient.findOne({ state: 'running' })) {
			throw new N9Error('one-already-running', 400, {});
		}

		const expireDate = await this.uptoboxClient.getAccountExpireDate();
		if (moment().add(3, 'month').isAfter(expireDate)) {
			this.logger.warn(`Uptobox expiration date is soon !!!!!`, { expireDate });
		}

		const sync = await this.mongoClient.insertOne({
			state: 'running',
			startDate: new Date(),
		}, 'app');

		const allFilesToSync = await this.filesService.findAllFilesToSyncAsStream();

		await allFilesToSync.forEachAsync(async (file) => {
			try {
				// todo: add to a promise pool

				// check file exist
				const isFileExists = await FsExtra.pathExists(file.fullPath);
				if (!isFileExists) {
					throw new N9Error('file-not-found', 404, {});
				}
				// send ftp
				const ftpClient = new BasicFTP.Client();
				await ftpClient.access(this.conf.uptobox.ftp.auth);
				const ftpClientIndex = this.activeFtpClients.push(ftpClient);
				await ftpClient.upload(FsExtra.createReadStream(file.fullPath), file.name);
				this.activeFtpClients.splice(ftpClientIndex, 1);
				ftpClient.close();

				// fetch file details from FTP folder
				const fileCode = await this.uptoboxClient.getFileIdFromNameInFTPFolder(file.name);

				// set file private
				await this.uptoboxClient.setFilePrivate(fileCode);

				// ensure file destination directory exists
				const originalDirectory = this.conf.files.directories.find((directory) => directory.path === file.directoryBasePath);
				const remotePath = originalDirectory.remotePrefix + file.fullPath.replace(new RegExp('^' + _.escapeRegExp(originalDirectory.path)), '');
				const targetFolderId = await this.uptoboxClient.ensureFolder(remotePath);

				// move file
				await this.uptoboxClient.moveFileToTargetFolder(fileCode, targetFolderId);
			} catch (e) {
				this.logger.error(`Error while sending file`, e , JSON.stringify(e));
				await this.filesService.saveErrorToFile(file._id, {
					name: e.name,
					message: e.message,
					context: e.context,
					status: e.status
				});
			}
		});

		await this.mongoClient.findOneAndUpdateById(sync._id, {
			$set: {
				state: 'end-ok',
				endDate: new Date(),
			}
		}, 'app');

	}

	public async beforeShutdown(): Promise<void> {
		this.logger.info(`Close FTP connexion before shutdown`);
		for (const activeFtpClient of this.activeFtpClients) {
			activeFtpClient.close();
		}
		// todo: add clear ftp transfers
	}
}
