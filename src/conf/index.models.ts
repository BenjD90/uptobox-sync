import { N9Log } from '@neo9/n9-node-log';
import { AccessOptions } from 'basic-ftp';
import { N9NodeRouting } from 'n9-node-routing';

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
		minSizeMegaBytes?: number;
		directories: {
			path: string;
			remotePrefix: string
		}[]
	};
	uptobox?: {
		url?: string;
		token?: string;
		uploadType?: 'ftp' | 'http';
		concurrencyLimit?: number;
		poolSize?: number;
		ftp?: {
			auth: AccessOptions
		},
		http?: {
			url?: string;
			sessionId?: string;
		}
	};
}
