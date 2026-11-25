import { Driver } from './base';
import { DJI_MODELS, DjiDriver } from './dji';
import { DM_MODELS, DmDriver } from './dm';
import { GD_MODEL, GD_MODELS, GdDriver } from './gd';

export const PROTOCOLS: Record<'dm' | 'dji' | 'gd', { name: string; models: string[] }> = {
  dm: { name: '达妙/HM MIT', models: Object.keys(DM_MODELS) },
  dji: { name: '大疆 RoboMaster', models: Object.keys(DJI_MODELS) },
  gd: { name: '高擎 GD', models: GD_MODELS },
};

export function makeDriver(
  protocol: 'dm' | 'dji' | 'gd',
  model: string,
  motorId: number,
  masterId = 0,
): Driver {
  if (protocol === 'dm') {
    return new DmDriver(model, motorId, masterId);
  }
  if (protocol === 'dji') {
    return new DjiDriver(model, motorId);
  }
  if (protocol === 'gd') return new GdDriver(model || GD_MODEL, motorId);
  throw new Error(`未知协议 ${protocol as string}`);
}
