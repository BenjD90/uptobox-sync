import { JsonController, Post, Get, QueryParam } from '@flyacts/routing-controllers';
import { N9Log } from '@neo9/n9-node-log';
import { Inject, Service } from 'typedi';
import { SyncService } from './sync.service';
import { UptoboxClient } from './uptobox.client';

@Service()
@JsonController('/sync')
export class SyncController {
	@Inject('logger')
	private logger: N9Log;

	constructor(
			private syncService: SyncService,
			private uptoboxClient: UptoboxClient,
	) {
	}

	@Post('/')
	public async startSync(): Promise<void> {
		await this.syncService.startSynchronisation();
	}

	@Get('/remoteFolder')
	public async findRemoteFolder(
			@QueryParam('path') path: string = '/'
	): Promise<number> {
		return await this.uptoboxClient.findRemoteFolder(path);
	}
}
