import { N9Log } from '@neo9/n9-node-log';
import { N9NodeRouting } from 'n9-node-routing';
import {  AccessOptions} from 'basic-ftp';

export interface Conf {
	// n9-micro config
	http?: N9NodeRouting.HttpOptions;
	log?: N9Log.Options;
	env?: string;
	name?: string;
	version?: string;

	// Custom config
	mongo?: {
		url: string;
	};
	io?: {
		enabled: boolean;
	};
	files?: {
		directories: {
			path: string;
			remotePrefix: string
		}[]
	};
	uptobox?: {
		url: string;
		token: string;
		ftp: {
			auth: AccessOptions
		}
	};
}
