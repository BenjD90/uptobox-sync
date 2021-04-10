import { BaseMongoObject } from '@neo9/n9-mongo-client/dist/src/models';
import { N9Error } from '@neo9/n9-node-utils';

export class FileEntity extends BaseMongoObject {
	public name: string;
	public fullPath: string;
	public directoryFullPath: string;
	/**
	 * Directory path that was used to find the file
	 */
	public directoryBasePath: string;
	public syncDate?: Date;
	public fileCode?: string; // uptobox file id
	public fileSizeByte: number;

	public error?: N9Error;
}

export class FileListItem extends BaseMongoObject {
}
