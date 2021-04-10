import * as _ from 'lodash';
import * as numeral from 'numeral';

export class Utils {

	public static sizeToGB(nbBytesTreated: number, precision: number = 2, numberOfDigitMax: number = 4): string {
		const value = _.round(nbBytesTreated / (1024 * 1024 * 1024), precision);
		return numeral(value).format('0,0.' + '0'.repeat(precision)).replace(',', ' ').padStart(numberOfDigitMax + Math.ceil(numberOfDigitMax / 3) /*thousand sep */ + 1 /*comma*/ + precision);
	}

	public static formatMBOrMb(speedInMB: number): string {
		return numeral(_.round(speedInMB, 2)).format('0,0.000').padStart(7);
	}
}
