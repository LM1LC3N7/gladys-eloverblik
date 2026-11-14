// -----------------------------------------------------------------------------
// Answers of the Eloverblik customer API, shaped after the schemas of its
// Swagger (api.eloverblik.dk/customerapi, V1.0): fake tokens and fake
// metering point ids.
// -----------------------------------------------------------------------------

import { HOUR } from '../../src/constants.js';
import { nextDate, parseLocalDate } from '../../src/time.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A refresh token shaped as a JWT, expiring on 2027-06-30 (its signature is fake). */
export const TOKEN = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
  tokenName: 'gladys',
  exp: Date.UTC(2027, 5, 30, 12) / 1000,
})}.SECRETsignature0123456789`;
export const TOKEN2 = `${b64({ alg: 'HS256' })}.${b64({ sub: 'other' })}.OTHERsignature9876543210`;
export const ACCESS = 'access-SECRET-eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9';
export const MP = '571313100000001234';
export const MP2 = '571313100000005678';
export const MP_PROD = '571313100000009999';
export const ID_KEY = 'a'.repeat(64);
/** Wednesday 11 November 2026, 13:30 in Copenhagen (12:30 UTC): after the daily read. */
export const NOW = Date.UTC(2026, 10, 11, 12, 30);

export const token = (value = ACCESS) => ({ result: value });

export function meteringPoints(ids = [MP], { production = [MP_PROD] } = {}) {
  const point = (id, type) => ({
    streetCode: '0001',
    streetName: 'Testvej',
    buildingNumber: '1',
    postcode: '8000',
    cityName: 'Aarhus C',
    meteringPointId: id,
    typeOfMP: type,
    balanceSupplierName: 'Test Energi A/S',
    hasRelation: true,
    consumerCVR: '',
    dataAccessCVR: '',
    childMeteringPoints: [],
    firstConsumerPartyName: 'SECRET PERSON NAME',
    meterNumber: '12345678',
    settlementMethod: 'E02',
    meterReadingOccurrence: 'PT1H',
  });
  return {
    result: [...ids.map((id) => point(id, 'E17')), ...production.map((id) => point(id, 'E18'))],
  };
}

/** The kWh of the hour starting at `at` (ms): varies with the hour, 3 decimals. */
export const hourly = (at) => Math.round((0.3 + ((at / HOUR) % 24) * 0.05) * 1000) / 1000;

/**
 * A gettimeseries answer: one period per local day of Denmark from `from`
 * (included) to `to` (excluded), PT1H points; `value(at, id)` gives the kWh of
 * the hour (undefined: the day ends there; null: an A02 point, no quantity).
 */
export function timeSeries({ ids = [MP], from, to, value = hourly, quality = 'A04' }) {
  return {
    result: ids.map((id) => {
      const periods = [];
      for (let d = from; d < to; d = nextDate(d)) {
        const start = parseLocalDate(d);
        const end = parseLocalDate(nextDate(d));
        const points = [];
        for (let at = start, pos = 1; at < end; at += HOUR, pos += 1) {
          const v = value(at, id);
          if (v === undefined) break;
          points.push(
            v === null
              ? { position: String(pos), 'out_Quantity.quality': 'A02' }
              : {
                  position: String(pos),
                  'out_Quantity.quantity': v.toFixed(3),
                  'out_Quantity.quality': quality,
                },
          );
        }
        if (!points.length) break;
        periods.push({
          resolution: 'PT1H',
          timeInterval: {
            start: new Date(start).toISOString().replace('.000Z', 'Z'),
            end: new Date(end).toISOString().replace('.000Z', 'Z'),
          },
          Point: points,
        });
      }
      return {
        success: true,
        errorCode: 10000,
        errorText: 'NoError',
        id,
        stackTrace: null,
        MyEnergyData_MarketDocument: {
          mRID: 'doc-1',
          createdDateTime: '2026-11-11T08:00:00Z',
          'sender_MarketParticipant.name': 'Energinet',
          'sender_MarketParticipant.mRID': { codingScheme: null, name: null },
          'period.timeInterval': { start: from, end: to },
          TimeSeries: [
            {
              mRID: id,
              businessType: 'A04',
              curveType: 'A01',
              'measurement_Unit.name': 'KWH',
              MarketEvaluationPoint: { mRID: { codingScheme: 'A10', name: id } },
              Period: periods,
            },
          ],
        },
      };
    }),
  };
}

/** A failed result for one metering point (HTTP 200, success false). */
export const failed = (id, errorCode = 30015, errorText = 'NoDataAvailable') => ({
  success: false,
  errorCode,
  errorText,
  id,
  stackTrace: null,
  MyEnergyData_MarketDocument: null,
});
