// -----------------------------------------------------------------------------
// The Gladys devices (pure). Read-only features only: nothing is commanded.
//
// External ids (forever):
//   ext:<selector>:mp:<key>   a consumption metering point; key = 16 hex
//                             digits of an HMAC-SHA-256 of its 18-digit id
//                             under the id key kept in the Gladys config (the
//                             id itself is never in an external id, a log, a
//                             status or /data). The device name shows its
//                             last 4 digits only.
//
// One feature: the 30-minute consumption, fed by publishEnergyConsumption
// with the hours Eloverblik serves one or two days later (each hour in two
// equal halves). Never an index (an index published a day late would pile a
// whole day into one half hour), never publishStates.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { MAX_HALF_HOUR_KWH } from './constants.js';
import { t } from './i18n.js';

export const KIND = 'mp';
export const FEATURE = Object.freeze({ CONSUMPTION: 'consumption' });

export const idsOf = (gladys, key) => gladys.externalIds(KIND, key);

/** The key of one of our device or feature external ids; undefined otherwise. */
export function parseDeviceId(externalId) {
  const match = /:mp:([0-9a-f]{16})(?::([a-z_]+))?$/.exec(String(externalId ?? ''));
  return match ? { key: match[1], feature: match[2] } : undefined;
}

/** The device of a metering point: `{ key, suffix, supplier }`. */
export function buildMeterDevice(gladys, meter, language = 'en') {
  const ids = idsOf(gladys, meter.key);
  return {
    name: t('deviceMeter', language, { suffix: meter.suffix }),
    external_id: ids.device,
    features: [
      {
        name: t('featureConsumption', language),
        external_id: ids.feature(FEATURE.CONSUMPTION),
        category: C.ENERGY_SENSOR,
        type: T.ENERGY_SENSOR.THIRTY_MINUTES_CONSUMPTION,
        unit: U.KILOWATT_HOUR,
        read_only: true,
        has_feedback: false,
        keep_history: true,
        min: 0,
        max: MAX_HALF_HOUR_KWH,
      },
    ],
    params: [
      { name: 'metering_point_suffix', value: meter.suffix },
      { name: 'supplier', value: meter.supplier ?? '' },
    ],
  };
}
