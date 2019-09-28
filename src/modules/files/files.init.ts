import { N9Log } from '@neo9/n9-node-log';
import { FilesService } from './files.service';

export default async (log: N9Log) => {
	log = log.module('list-files');

	log.info('Ensuring file names unique index');
	const filesService = await require('typedi').Container.get(FilesService) as FilesService;
	await filesService.initIndexes();
};
