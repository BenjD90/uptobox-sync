import { JsonController, Post } from '@flyacts/routing-controllers';
import { N9Log } from '@neo9/n9-node-log';
import { Inject, Service } from 'typedi';
import { SyncService } from './sync.service';

@Service()
@JsonController('/sync')
export class SyncController {
	@Inject('logger')
	private logger: N9Log;

	constructor(private syncService: SyncService) {
	}

	@Post('/')
	public async startSync(): Promise<void> {
		await this.syncService.startSync();
	}
}
