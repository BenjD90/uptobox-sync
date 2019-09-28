import { Conf } from './index.models';

const conf: Conf = {
	http: {
		port: process.env.PORT || 6686,
	},
	mongo: {
		url: 'mongodb://127.0.0.1:27018/uptobox-sync'
	},
	files: {
		directories: [
				'/home/benjamin/temp/files'
		]
	}
};

export default conf;
