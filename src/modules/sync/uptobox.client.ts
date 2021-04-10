import { N9Error, waitFor } from '@neo9/n9-node-utils';
import * as FsExtra from 'fs-extra';
import * as _ from 'lodash';
import * as moment from 'moment';
import { N9HttpClient } from 'n9-node-routing';
import * as path from 'path';
import * as ProgressStream from 'progress-stream';
import { Inject, Service } from 'typedi';
import { Conf } from '../../conf/index.models';
import { N9Log } from '@neo9/n9-node-log';
import { StringMap } from '@neo9/n9-mongo-client/dist/src/models';
import * as FormData from 'form-data';
import { link } from 'fs';

interface UptoboxResponse<T> {
	statusCode: number;
	message: string;
	data: T;
}

interface LinkInfoResponse {
	list: (
		{ file_code: string; file_name?: string; error?: { code: number; message: string } }
		&
		{ code: string; message: string }
	)[]
}

@Service()
export class UptoboxClient {

	@Inject('N9HttpClient')
	private readonly httpClient: N9HttpClient;
	private readonly token: string;

	constructor(@Inject('conf') private readonly conf: Conf,
		@Inject('logger') private readonly logger: N9Log) {
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

	public async getFileIdFromNameInFTPFolder(name: string): Promise<string | undefined> {
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
			return;
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
		if (!remotePath.startsWith('/')) {
			throw new N9Error('can-create-remote-path-only-with-full-path', 400, { remotePath });
		}

		const remotePathParts = remotePath.split('/');
		let remoteFolderId: number;
		let pathConcatenated = '/';
		for (const remotePathPart of remotePathParts.slice(1)) {
			pathConcatenated = path.join(pathConcatenated, remotePathPart);
			remoteFolderId = await this.findRemoteFolder(pathConcatenated);
			if (!remoteFolderId) {
				await this.createRemoteFolder(pathConcatenated);
				remoteFolderId = await this.findRemoteFolder(pathConcatenated);
			}
		}
		return remoteFolderId;
	}

	public async moveFileToTargetFolder(fileCode: string, targetFolderId: number): Promise<void> {
		await this.httpClient.patch([this.conf.uptobox.url, 'user', 'files'], undefined, {
			token: this.token,
			file_codes: fileCode,
			destination_fld_id: targetFolderId,
			action: 'move',
		});
	}

	public async uploadViaHTTP(fullPath: string, name: string, fileSize: number, onProgress: (update: ProgressStream.Progress) => void): Promise<string> {
		const progressStream = ProgressStream({
			length: fileSize,
			time: 500, // print every 500 ms
		}).on('progress', (update) => {
			onProgress(update);
		});

		let fileStream = FsExtra.createReadStream(fullPath)
			.pipe(progressStream);

		const body = new FormData();
		body.append('files', fileStream, {
			filename: name,
			contentType: null
		})
		const fileUploadResponse = await this.httpClient.raw<{
			files: {
				name: string,
				size: number,
				url: string,
				deleteUrl: string
			}[]
		}>([this.conf.uptobox.http.url, `upload`], {
			method: 'post',
			body,
			searchParams: {
				sess_id: this.conf.uptobox.http.sessionId,
			},
		});

		if (!fileUploadResponse.files) {
			throw new N9Error('missing-files-in-response', 500, { fileUploadResponse });
		}

		const fileCode = _.last(fileUploadResponse.files[0].url.split('/'));
		return fileCode;
	}

	public async findRemoteFolder(remotePath: string): Promise<number> {
		try {
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
			if (folderDetails.statusCode !== 0) {
				if ((folderDetails.data as any) === 'Could not find current path') {
					return;
				}
				throw new N9Error('uptobox-error', 500, { remotePath, error: folderDetails });
			}
			return folderDetails.data.currentFolder.fld_id;
		} catch (e) {
			throw new N9Error('error-while-reading-folder', 500, { remotePath, e: JSON.parse(JSON.stringify(e)) });
		}
	}

	public async createRemoteFolder(remotePath: string): Promise<void> {
		let params = {
			path: '/' + path.normalize(path.dirname(remotePath)),
			name: path.basename(remotePath),
		};
		const res = await this.httpClient.put<UptoboxResponse<string>>([this.conf.uptobox.url, 'user', 'files'], undefined, {
			token: this.token,
			...params,
		});
		if (res.statusCode !== 0) {
			throw new N9Error('uptobox-error', 500, { remotePath, error: res });
		}
	}

	public async checkFilesExists(fileCodes: string[], nbTry: number = 0): Promise<StringMap<boolean>> {
		const response: StringMap<boolean> = {};
		if (fileCodes.length) {
			const params = {
				token: this.token,
				fileCodes: fileCodes.join(',')
			};

			const res = await this.httpClient.get<UptoboxResponse<LinkInfoResponse>>(
				[this.conf.uptobox.url, 'link', 'info'], params);
			if (res.statusCode !== 0) {
				throw new N9Error('uptobox-error', 500, { params });
			}
			for (const linkInfo of res.data.list) {
				if (linkInfo.code) { // it's an error
					this.logger.error(`Error while checking file existance : ${linkInfo.code} ${linkInfo.message}`)
					throw new N9Error(linkInfo.code, 500, { linkInfo });
				} else if (!linkInfo.error) {
					response[linkInfo.file_code] = true;
				} else {
					this.logger.warn(`File error ${linkInfo.error?.code} : ${linkInfo.file_code} (${linkInfo?.file_name}) ${linkInfo.error?.message} ${JSON.stringify(linkInfo)}`);
					if (linkInfo.error?.code === 25) { // error 503
						if (nbTry < 5) {
							const waitTimeMS = 40 * 1_000;
							this.logger.warn(`Retry in ${waitTimeMS / 1_000} s checkFilesExists ${JSON.stringify(linkInfo)}, nbTry = ${nbTry}`);
							await waitFor(waitTimeMS);
							nbTry += 1;
							const valRetried = await this.checkFilesExists([linkInfo.file_code], nbTry);
							response[linkInfo.file_code] = valRetried[linkInfo.file_code];
						} else {
							throw new N9Error('server-temporary-unavailable', 503, { linkInfo });
						}
					}
					response[linkInfo.file_code] = false;
				}
			}
		}
		await waitFor(500); // add a pause to not call uptobox api to frequently
		return response;
	}

	public async findRemoteFileByPath(remoteFolderPath: string, fileName: string): Promise<string> {
		try {
			const fileDetails = await this.httpClient.get<UptoboxResponse<{
				path: string,
				files: {
					file_name: string,
					file_code: string
				}[]
			}>>([this.conf.uptobox.url, 'user', 'files'], {
				token: this.token,
				limit: 1,
				path: '/' + remoteFolderPath,
				searchField: 'file_name',
				search: fileName
			});
			if (fileDetails.statusCode !== 0) {
				if ((fileDetails.data as any) === 'Could not find current path') {
					return;
				}
				throw new N9Error('uptobox-error', 500, { remotePath: remoteFolderPath, error: fileDetails });
			}
			if (fileDetails.data.files.length === 0) {
				this.logger.warn(`file-not-found ${remoteFolderPath} ${fileName}`);
				return;
			}
			return fileDetails.data.files[0].file_code;
		} catch (e) {
			throw new N9Error('error-while-reading-files', 500, { remotePath: remoteFolderPath, e: JSON.parse(JSON.stringify(e)) });
		}
	}
}
