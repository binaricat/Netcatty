import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const root=fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const require=createRequire(root+'/package.json');
const ts=require('typescript');
const bridge=require(root+'/electron/bridges/terminalBridge.cjs');
test('serial input combinations preserve the preceding device bytes after CJK deletion', async () => {
const modules = await Promise.all([
'domain/serialCharMetrics.ts', 'components/terminal/runtime/terminalInputSanitize.ts',
'components/terminal/runtime/terminalBackspaceInput.ts', 'components/terminal/runtime/terminalPerCharacterInput.ts',
'components/terminal/runtime/terminalSudoAutofill.ts', 'components/terminal/runtime/terminalCommandExecution.ts',
'components/terminal/runtime/serialLocalEcho.ts', 'components/terminal/autocomplete/terminalStringCellWidth.ts',
'components/terminal/runtime/shiftEnterText.ts',
].map(p=>import(root+'/'+p)));
const source=fs.readFileSync(root+'/components/terminal/runtime/createXTermRuntime.ts','utf8');
const start=source.indexOf('let lastInputWasPrintable =');
const end=source.indexOf('  let kittyCompositionPending',start);
const code=ts.transpileModule(source.slice(start,end)+ '\n globalThis.api = {handleTerminalInputData,recordSerialSnippetInput,getConfidence:()=>lastInputWasPrintable};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
for (const encoding of ['utf-8','gb18030']) {
for (const insert of ['typed','raw','bracketed','snippet']) {
for (const prefix of ['fresh','empty-arrow','submit','paste-submit','interrupt','clear']) {
 let wire=Buffer.alloc(0);
 const session={encoding, serialPort:{write(data: string | Buffer){for(const byte of Buffer.from(data)) { if(byte===127||byte===8) wire=wire.subarray(0,Math.max(0,wire.length-1)); else wire=Buffer.concat([wire,Buffer.from([byte])]);}}}};
 bridge.init({sessions:new Map([['s',session]]),electronModule:{}});
 const ctx={host:{protocol:'serial',id:'h',label:'h'},sessionId:'s',sessionRef:{current:'s'},statusRef:{current:'connected'},commandBufferRef:{current:''},onBroadcastInputRef:{current:null},isBroadcastEnabledRef:{current:false},terminalBackend:{writeToSession(id:string,data:string,opts: {serialEraseChar?: string; sensitive?: boolean}){bridge.writeToSession({}, {sessionId:id,data,...opts})}},serialByteOrientedBackspace:true,serialLocalEcho:false};
 const env={...Object.assign({},...modules),api: undefined as unknown as {handleTerminalInputData: (data: string) => void; recordSerialSnippetInput: (data: string) => void},ctx,term:{buffer:{active:{cursorX:0,cursorY:0,baseY:0,getLine:()=>undefined}},cols:80},suppressNextTerminalDataBroadcast:false,handlingKittyBroadcast:false,shouldBroadcastTerminalUserInput:()=>false,prioritizeTerminalInput:()=>{},getFlowControllerForTerm:()=>null,shouldSuppressTerminalInputScrollForUserPaste:()=>true,scrollToBottomAfterInput:()=>{},writeLocalTerminalData:()=>{}};
 vm.runInNewContext(code,env); const {handleTerminalInputData:input,recordSerialSnippetInput:snippet}=env.api;
 if(prefix==='empty-arrow') input('\x1b[D');
 if(prefix==='submit') {input('旧');input('\x1b[D');input('\r');}
 if(prefix==='paste-submit') {input('\x1b[D');input('旧\r');}
 if(prefix==='interrupt') {input('旧');input('\x1b[D');input('\x03');}
 if(prefix==='clear') {input('旧');input('\x1b[D');input('\x15');}
 assert.equal(ctx.commandBufferRef.current,''); wire=Buffer.alloc(0);
 if(insert==='typed') {input('a');input('b');input('你');input('好');}
 if(insert==='raw') input('ab你好');
 if(insert==='bracketed') input('\x1b[200~ab你好\x1b[201~');
 if(insert==='snippet') {ctx.terminalBackend.writeToSession('s','ab你好',{});snippet('ab你好');}
 // Device paste framing is a transport protocol, remove it from our byte-deleting model.
 if(insert==='bracketed') wire=wire.subarray(6,wire.length-6);
 input('\x7f');input('\x7f');
 assert.equal(ctx.commandBufferRef.current,'ab',`${encoding}/${insert}/${prefix} buffer`);
 assert.equal(wire.toString(),'ab',`${encoding}/${insert}/${prefix} device`);
}
}
}
});
