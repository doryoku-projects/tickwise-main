import {describe,it,expect} from 'vitest';
import {poolObservationTick} from '../src/charts/pool-observation-tick.js';
describe('canonical pool chart ticks',()=>{
 it.each([['0',0],['-100',-100],['887272',887272],[-887272,-887272]])('preserves %s without price-orientation inference',(input,want)=>{expect(poolObservationTick(input)).toBe(want);});
 it.each([null,undefined,'',true,'1.5','1e3','887273',-887273,NaN,Infinity])('keeps missing or invalid tick %s unknown',input=>{expect(poolObservationTick(input)).toBeNull();});
});
