import * as _ from 'lodash';

export class Utils {

	public static sizeToGo(nbBytesTreated: number, precision: number = 2, numberOfDigitMax: number = 4) {
		return _.round(nbBytesTreated / (1024 * 1024 * 1024), precision).toLocaleString().padStart(numberOfDigitMax + Math.ceil(numberOfDigitMax / 3) /*thousand sep */ + 1/*comma*/ + precision);
	}
}
