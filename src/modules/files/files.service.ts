import { MongoClient, MongoReadStream } from '@neo9/n9-mongo-client';
import { N9Log } from '@neo9/n9-node-log';
import { N9Error } from '@neo9/n9-node-utils';
import { Cursor } from 'mongodb';
import * as path from 'path';
import { Inject, Service } from 'typedi';
import { Conf } from '../../conf/index.models';
import { FileEntity, FileListItem } from './files.models';
import * as fastGlob from 'fast-glob';
import * as FsExtra from 'fs-extra';

@Service()
export class FilesService {
	@Inject('conf')
	private conf: Conf;

	@Inject('logger')
	private logger: N9Log;

	private mongoClient: MongoClient<FileEntity, FileListItem>;

	constructor() {
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

	public async findAllFilesToSyncAsStream(): Promise<MongoReadStream<Partial<FileEntity>, Partial<FileEntity>>> {
		return this.mongoClient.streamWithType(this.getQueryForAllFilesToSync(), FileEntity, 1);
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

	public async setSynced(id: string) {
		await this.mongoClient.findOneAndUpdateById(id, {
			$set: {
				syncDate: new Date(),
			},
		}, 'app');
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
}
