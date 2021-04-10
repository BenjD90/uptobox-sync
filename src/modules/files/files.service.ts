import { MongoClient, MongoReadStream } from '@neo9/n9-mongo-client';
import { N9Log } from '@neo9/n9-node-log';
import { N9Error } from '@neo9/n9-node-utils';
import * as fastGlob from 'fast-glob';
import * as FsExtra from 'fs-extra';
import * as _ from 'lodash';
import { Cursor } from 'mongodb';
import * as path from 'path';
import { Inject, Service } from 'typedi';
import { Conf } from '../../conf/index.models';
import { UptoboxClient } from '../sync/uptobox.client';
import { FileEntity, FileListItem } from './files.models';
import * as PromisePool from 'promise-pool-executor';

@Service()
export class FilesService {
	@Inject('conf')
	private conf: Conf;

	@Inject('logger')
	private logger: N9Log;

	private mongoClient: MongoClient<FileEntity, FileListItem>;

	constructor(
		private uptoboxClient: UptoboxClient
	) {
		this.mongoClient = new MongoClient('files', FileEntity, FileListItem, {
			keepHistoric: true,
		});
	}

	public async initIndexes(): Promise<void> {
		await this.mongoClient.createUniqueIndex('name');
		await this.mongoClient.createIndex('syncDate');
	}

	public async refreshFilesIndex(): Promise<void> {
		const directories = this.conf.files.directories;
		for (const directory of directories) {
			this.logger.debug(`Reading ${directory.path}`);
			const files = await fastGlob(directory.path + '/**/*', {
				absolute: true,
				onlyFiles: true,
			});
			this.logger.info(`Found ${files.length.toLocaleString()} files in ${directory.path}`);
			for (const file of files) {
				const size = (await FsExtra.stat(file)).size;
				const name = path.basename(file);
				const directoryFullPath = path.dirname(file);
				if (size > this.conf.files.minSizeMegaBytes * 1_024 * 1_024) { // 2 Mo
					await this.mongoClient.findOneAndUpsert({ name }, {
						$set: {
							fullPath: file,
							name,
							fileSizeByte: size,
							directoryFullPath,
							directoryBasePath: directory.path,
						} as FileEntity,
					}, 'app', undefined, false);
				}
			}
		}

		const nbFilesToSync1 = await this.countAllFilesToSync();
		this.logger.info(`Nb files to sync : ${nbFilesToSync1}`);
		this.logger.info(`Check file already sync existances online`);

		const nbFilesMissingFileCode = await this.mongoClient.count(this.getFileMissingFileCodeQuery());
		this.logger.info(`Check ${nbFilesMissingFileCode} files missing fileCodes`);
		const pool = new PromisePool.PromisePoolExecutor({
			concurrencyLimit: 2,
		});
		const fileSyncWithoutFileCode = this.mongoClient.streamWithType(this.getFileMissingFileCodeQuery(), FileEntity, 100);
		let i = 0;
		await fileSyncWithoutFileCode.forEachPage(async (files: FileEntity[]) => {
			await pool.addEachTask({
				data: files,
				generator: async (file) => {
					const originalDirectory = this.conf.files.directories.find((directory) => directory.path === file.directoryBasePath);
					if (originalDirectory) {
						const remotePath = originalDirectory.remotePrefix + file.directoryFullPath.replace(new RegExp('^' + _.escapeRegExp(originalDirectory.path)), '');
						const fileCode = await this.uptoboxClient.findRemoteFileByPath(remotePath, file.name);
						if (fileCode) {
							await this.mongoClient.findOneAndUpdateById(file._id, { $set: { fileCode } }, 'app', undefined, false);
						} else {
							await this.mongoClient.findOneAndUpdateById(file._id, { $set: { error: new N9Error('file-remote-not-found', 404, { remotePath, fileName: file.name }) } }, 'app', undefined, false);
						}
					} else {
						this.logger.info(`File ignored because it refer to a directory not referenced in config : ${file.directoryBasePath}`);
					}
					i++;
				}
			})
				.promise();
			this.logger.debug(`Checked ${i.toString(10).padStart(7)} files`);
		});

		const nbFilesToCheck = await this.mongoClient.count(this.getQueryForAllFilesSync());
		this.logger.info(`Check if files (${nbFilesToCheck}) are still online`);
		const pageSize = 100; // max 100 api limit
		const fileSync = await this.findAllFilesAlreadySyncAsStream(pageSize);
		i = 0;
		await fileSync.forEachPage(async (files) => {
			const checkResults = await this.uptoboxClient.checkFilesExists(files.map((f) => f.fileCode));
			for (const [fileCode, found] of Object.entries(checkResults)) {
				if (!found) {
					await this.mongoClient.findOneAndUpdateByKey(fileCode, {
						$unset: {
							syncDate: 1,
							fileCode: 1
						}
					}, 'app', 'fileCode', undefined, false);
				}
			}
			i += pageSize;
			this.logger.debug(`${i.toString().padStart(7)} files online status checked`);
		});

		const nbFilesToSync2 = await this.countAllFilesToSync();
		this.logger.info(`Nb files to sync : ${nbFilesToSync2}`);
	}

	public async listFiles(page: number, pageSize: number, isSync: boolean): Promise<Cursor<FileListItem>> {
		const query: any = {};
		if (isSync === true) {
			query['syncDate'] = {
				$exists: true,
			};
		} else if (isSync === false) {
			query['syncDate'] = {
				$exists: false,
			};
		}
		return await this.mongoClient.find(query, page, pageSize);
	}

	public async findAllFilesToSyncAsStream(pageSize: number = 1): Promise<MongoReadStream<Partial<FileEntity>, Partial<FileEntity>>> {
		return this.mongoClient.streamWithType(this.getQueryForAllFilesToSync(), FileEntity, pageSize);
	}

	public async findAllFilesAlreadySyncAsStream(pageSize: number = 1): Promise<MongoReadStream<Partial<FileEntity>, Partial<FileEntity>>> {
		return this.mongoClient.streamWithType(this.getQueryForAllFilesSync(), FileEntity, pageSize);
	}

	public async countAllFilesToSync(): Promise<number> {
		return this.mongoClient.count(this.getQueryForAllFilesToSync());
	}

	public async saveErrorToFile(id: string, error: N9Error): Promise<void> {
		await this.mongoClient.findOneAndUpdateById(id, {
			$set: {
				error,
			},
		}, 'app');
	}

	public async setSynced(id: string, fileCode: string): Promise<void> {
		await this.mongoClient.findOneAndUpdateById(id, {
			$set: {
				fileCode,
				syncDate: new Date(),
			},
		}, 'app');
	}

	public async sumAllSizesToSync(): Promise<number> {
		let sum = 0;
		const s = await this.findAllFilesToSyncAsStream(100);
		await s.forEachPage(async (files) => {
			sum += _.sumBy(files, (file) => file.fileSizeByte);
		});
		return sum;
	}

	private getQueryForAllFilesToSync(): object {
		return {
			syncDate: {
				$exists: false,
			},
			error: {
				$exists: false,
			},
		};
	}

	private getQueryForAllFilesSync(): object {
		return {
			syncDate: {
				$exists: true,
			},
			fileCode: {
				$exists: true,
			},
			error: {
				$exists: false,
			},
		};
	}

	private getFileMissingFileCodeQuery(): object {
		return {
			syncDate: {
				$exists: true,
			},
			fileCode: {
				$exists: false
			},
			error: {
				$exists: false,
			},
		};
	}
}
