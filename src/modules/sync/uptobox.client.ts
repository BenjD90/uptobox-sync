import { N9Error } from '@neo9/n9-node-utils';
import { N9HttpClient } from 'n9-node-routing';
import * as path from 'path';
import { Inject, Service } from 'typedi';
import { Conf } from '../../conf/index.models';
import * as moment from 'moment';

interface UptoboxResponse<T> {
	statusCode: number;
	message: string;
	data: T;
}

@Service()
export class UptoboxClient {

	@Inject('N9HttpClient')
	private readonly httpClient: N9HttpClient;
	private readonly token: string;

	constructor(@Inject('conf') private readonly conf: Conf) {
		this.token = conf.uptobox.token;
	}

	public async getAccountExpireDate(): Promise<Date> {
		const accountDetails = await this.httpClient.get<UptoboxResponse<{
			login: string,
			email: string,
			point: string,
			premium_expire: string,
		}>>([this.conf.uptobox.url, 'user', 'me'], {
			token: this.token,
		});

		return moment(accountDetails.data.premium_expire).toDate();
	}

	public async getFileIdFromNameInFTPFolder(name: string): Promise<string> {
		const allFiles = await this.httpClient.get<UptoboxResponse<{
			path: string,
			files: {
				file_name: string,
				file_code: string
			}[]
		}>>([this.conf.uptobox.url, 'user', 'files'], {
			token: this.token,
			limit: 100,
			path: '//FTP',
			orderBy: 'file_name',
		});

		const file = allFiles.data.files.find((f) => f.file_name === name);
		if (!file) {
			throw new N9Error('file-not-found-in-uptobox', 404, { name });
			// todo: retry next page
		}
		return file.file_code;
	}

	public async setFilePrivate(fileCode: string): Promise<void> {
		await this.httpClient.patch<UptoboxResponse<{
			updated: number
		}>>([this.conf.uptobox.url, 'user', 'files'], undefined, {
			token: this.token,
			file_code: fileCode,
			public: 0,
		});
	}

	/**
	 * @param remotePath path from root
	 */
	public async ensureFolder(remotePath: string): Promise<number> {
		const remotePathParts = remotePath.split(path.delimiter);
		let pathConcatenated = remotePathParts[0];
		let remoteFolderId: number;
		for (const remotePathPart of remotePathParts) {
			remoteFolderId = await this.findRemoteFolder(pathConcatenated);
			if (!remoteFolderId) {
				await this.createRemoteFolder(pathConcatenated);
				remoteFolderId = await this.findRemoteFolder(pathConcatenated);
			}
			pathConcatenated = path.join(pathConcatenated, remotePathPart);
		}
		return remoteFolderId;
	}

	public async moveFileToTargetFolder(fileCode: string, targetFolderId: number): Promise<void> {
		await this.httpClient.patch([this.conf.uptobox.url, 'user', 'files'], undefined, {
			token: this.token,
			file_codes: fileCode,
			destination_fld_id: targetFolderId,
			action: 'move'
		});
	}

	private async findRemoteFolder(remotePath: string): Promise<number> {
		const folderDetails = await this.httpClient.get<UptoboxResponse<{
			path: string,
			currentFolder: {
				fld_id: number
			}
		}>>([this.conf.uptobox.url, 'user', 'files'], {
			token: this.token,
			limit: 1,
			path: '/' + remotePath,
		});
		return folderDetails.data.currentFolder.fld_id;
	}

	private async createRemoteFolder(remotePath: string): Promise<void> {
		await this.httpClient.put<UptoboxResponse<string>>([this.conf.uptobox.url, 'user', 'files'], undefined, {
			token: this.token,
			path: '/' + path.normalize(path.dirname(remotePath)),
			name: path.basename(remotePath),
		});
	}
}
