import { MongoUtils } from '@neo9/n9-mongo-client';
import n9Conf from '@neo9/n9-node-conf';
// Dependencies
import n9Log from '@neo9/n9-node-log';
import { Server } from 'http';
import { Db } from 'mongodb';
import routingControllersWrapper, { N9NodeRouting } from 'n9-node-routing';
import { join } from 'path';
// Add source map supports
// tslint:disable:no-import-side-effect
import 'source-map-support/register';
import { Conf } from './conf/index.models';

// Handle Unhandled promise rejections
process.on('unhandledRejection', /* istanbul ignore next */ (err) => {
	throw err;
});

// Load project conf & set as global
const conf = global.conf = n9Conf({ path: join(__dirname, 'conf') }) as Conf;
// Load logging system
const log = global.log = n9Log(conf.name, global.conf.log);
// Load loaded configuration
log.info(`Conf loaded: ${conf.env}`);

// Start method
async function start(): Promise<{ server: Server, db: Db, conf: Conf }> {
	// Profile startup boot time
	log.profile('startup');
	// print app infos
	const initialInfos = `${conf.name} version : ${conf.version} env: ${conf.env}`;
	log.info('-'.repeat(initialInfos.length));
	log.info(initialInfos);
	log.info('-'.repeat(initialInfos.length));
	const iocContainer = require('typedi').Container;

	// Connect to MongoDB
	const db = global.db = await MongoUtils.connect(conf.mongo.url);

	const callbacksBeforeShutdown: N9NodeRouting.CallbacksBeforeShutdown[] = [];
	iocContainer.set('callbacksBeforeShutdown', callbacksBeforeShutdown);

	// Load modules
	const { server } = await routingControllersWrapper({
		hasProxy: false,
		enableLogFormatJSON: false,
		path: join(__dirname, 'modules'),
		http: conf.http,
		shutdown: {
			waitDurationBeforeStop: 0,
			callbacksBeforeShutdown,
		}
	});

	// Log the startup time
	log.profile('startup');
	// Return server and more for testing
	return { server, db, conf };
}

// Start server if not in test mode
/* istanbul ignore if */
if (conf.env !== 'test') {
	start()
			.then(() => {
				(global.log || console).info('Launch SUCCESS !');
			})
			.catch((e) => {
				(global.log || console).error('Error on launch', e);
				throw e;
			});
}

export default start;
