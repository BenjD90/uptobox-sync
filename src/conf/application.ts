import { Conf } from './index.models';

const conf: Conf = {
	http: {
		port: process.env.PORT || 6686,
	},
	mongo: {
		url: 'mongodb://127.0.0.1:27018/uptobox-sync'
	},
	files: {
		directories: [{
			path: '/home/benjamin/temp/files',
			remotePrefix: '/test'
		}]
	},
	uptobox: {
		url: 'https://uptobox.com/api/',
		token: '2df9a8a05ad0ed3199d44066d62ceaf25nyw4',
		ftp: {
			auth: {
				user: 'benjd',
				password: 'trompette90',
				host: 'ftp.uptobox.com',
				secure: false
			}
		}
	}
};

export default conf;
