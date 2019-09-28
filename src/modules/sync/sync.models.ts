import { BaseMongoObject } from '@neo9/n9-mongo-client/dist/src/models';

export class SyncEntity extends BaseMongoObject {
	public startDate: Date;
	public endDate?: Date;
	public state: 'running' | 'end-ok' | 'end-ko' | 'end-killed';
}
