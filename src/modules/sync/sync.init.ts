import { N9Log } from '@neo9/n9-node-log';
import { SyncService } from './sync.service';

export default async (log: N9Log) => {
	log = log.module('sync');

	log.info('Ensuring file names unique index');
	const syncService = await require('typedi').Container.get(SyncService) as SyncService;
	await syncService.init();
};
