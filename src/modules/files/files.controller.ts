import { Get, JsonController, Post, Res, QueryParam } from '@flyacts/routing-controllers';
import { N9Log } from '@neo9/n9-node-log';
import { N9JSONStream } from '@neo9/n9-node-utils';
import { Response } from 'express';
import { Inject, Service } from 'typedi';
import { FileListItem } from './files.models';
import { FilesService } from './files.service';

@Service()
@JsonController('/files')
export class FilesController {
	@Inject('logger')
	private logger: N9Log;

	constructor(private filesService: FilesService) {
	}

	@Post('/refresh')
	public async refreshFilesIndex(): Promise<void> {
		await this.filesService.refreshFilesIndex();
	}

	@Get('/')
	public async getFilesList(
			@Res() res: Response,
			@QueryParam('isSync') isSync: boolean,
			@QueryParam('size') size: number = 10
	): Promise<N9JSONStream<FileListItem>> {
		const files = await this.filesService.listFiles(0, size, isSync);
		return files
				.pipe(new N9JSONStream({
							res,
							total: await files.count(),
						})
				);
	}
}
