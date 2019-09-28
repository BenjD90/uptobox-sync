import { MongoClient } from '@neo9/n9-mongo-client';
import { N9Log } from '@neo9/n9-node-log';
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
			const files = await fastGlob(directory + '/**/*', {
				absolute: true,
				onlyFiles: true,
			});
			for (const file of files) {
				const size = (await FsExtra.stat(file)).size;
				const name = path.basename(file);
				const directoryFullPath = path.dirname(file);
				await this.mongoClient.findOneAndUpsert({ name }, {
					$set: {
						fullPath: file,
						name,
						fileSizeByte: size,
						directoryFullPath,
					},
				}, 'app', undefined, false);
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
}
