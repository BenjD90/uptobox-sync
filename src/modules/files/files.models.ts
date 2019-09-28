import { BaseMongoObject } from '@neo9/n9-mongo-client/dist/src/models';

export class FileEntity extends BaseMongoObject {
	public name: string;
	public fullPath: string;
	public directoryFullPath: string;
	/**
	 * Directory path that was used to find the file
	 */
	public directoryBasePath: string;
	public syncDate?: Date;
	public fileSizeByte: number;
}

export class FileListItem extends BaseMongoObject {
}
