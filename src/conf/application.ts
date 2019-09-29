import * as FsExtra from 'fs-extra';
import * as _ from 'lodash';
import { join } from 'path';
import { Conf } from './index.models';

let conf: Conf = {
	http: {
		port: process.env.PORT || 6686,
	},
	mongo: {
		url: 'mongodb://127.0.0.1:27018/uptobox-sync',
	},
	files: {
		directories: [],
		minSizeMegaBytes: 2,
	},
	uptobox: {
		url: 'https://uptobox.com/api/',
		preferredUploadType: 'ftp',
		concurrencyLimit: 6,
		poolSize: 10,
		ftp: {
			auth: {
				host: 'ftp.uptobox.com',
				secure: false,
			},
		},
		http: {},
	},
};

try {
	const homedir = require('os').homedir();

	const globalConf = FsExtra.readJSONSync(join(homedir, '.config', 'uptobox-sync.json'));
	conf = _.merge({}, conf, _.get(globalConf, 'application'));
} catch (e) {
	console.error(`Error while loading conf`, e);
	throw e;
}

export default conf;
