import {DataSegment} from "./segments/DataSegment";
import {PauseSegment} from "./segments/PauseSegment";
import {PulseGenerator} from "./segments/PulseGenerator";
import {PulseSequenceSegment} from "./segments/PulseSequenceSegment";
import {ToneSegment} from "./segments/ToneSegment";

export class TZXFile {
    static isValid(data) {
        const tzx = new DataView(data);

        const signature = "ZXTape!\x1A";
        for (let i = 0; i < signature.length; i++) {
            if (signature.charCodeAt(i) != tzx.getUint8(i)) {
                return false;
            }
        }
        return true;
    }

    constructor(data) {
        this.blocks = [];
        const tzx = new DataView(data);

        let offset = 0x0a;

        while (offset < data.byteLength) {
            const blockType = tzx.getUint8(offset);
            offset++;
            switch (blockType) {
                case 0x10:
                    (() => {
                        const pause = tzx.getUint16(offset, true);
                        offset += 2;
                        const dataLength = tzx.getUint16(offset, true);
                        offset += 2;
                        const blockData = new Uint8Array(data, offset, dataLength);
                        this.blocks.push({
                            'type': 'StandardSpeedData',
                            'pause': pause,
                            'data': blockData,
                            'generatePulses': (generator) => {
                                if (blockData[0] & 0x80) {
                                    // add short leader tone for data block
                                    generator.addSegment(new ToneSegment(2168, 3223));
                                } else {
                                    // add long leader tone for header block
                                    generator.addSegment(new ToneSegment(2168, 8063));
                                }
                                generator.addSegment(new PulseSequenceSegment([667, 735]));
                                generator.addSegment(new DataSegment(blockData, 855, 1710, 8));
                                if (pause) generator.addSegment(new PauseSegment(pause));
                            }
                        });
                        offset += dataLength;
                    })();
                    break;
                case 0x11:
                    (() => {
                        const pilotPulseLength = tzx.getUint16(offset, true); offset += 2;
                        const syncPulse1Length = tzx.getUint16(offset, true); offset += 2;
                        const syncPulse2Length = tzx.getUint16(offset, true); offset += 2;
                        const zeroBitLength = tzx.getUint16(offset, true); offset += 2;
                        const oneBitLength = tzx.getUint16(offset, true); offset += 2;
                        const pilotPulseCount = tzx.getUint16(offset, true); offset += 2;
                        const lastByteMask = tzx.getUint8(offset); offset += 1;
                        const pause = tzx.getUint16(offset, true); offset += 2;
                        const dataLength = tzx.getUint16(offset, true) | (tzx.getUint8(offset+2) << 16); offset += 3;
                        const blockData = new Uint8Array(data, offset, dataLength);
                        this.blocks.push({
                            'type': 'TurboSpeedData',
                            'pilotPulseLength': pilotPulseLength,
                            'syncPulse1Length': syncPulse1Length,
                            'syncPulse2Length': syncPulse2Length,
                            'zeroBitLength': zeroBitLength,
                            'oneBitLength': oneBitLength,
                            'pilotPulseCount': pilotPulseCount,
                            'lastByteMask': lastByteMask,
                            'pause': pause,
                            'data': blockData,
                            'generatePulses': (generator) => {
                                generator.addSegment(new ToneSegment(pilotPulseLength, pilotPulseCount));
                                generator.addSegment(new PulseSequenceSegment([syncPulse1Length, syncPulse2Length]));
                                generator.addSegment(new DataSegment(blockData, zeroBitLength, oneBitLength, lastByteMask));
                                if (pause) generator.addSegment(new PauseSegment(pause));
                            }
                        });
                        offset += dataLength;
                    })();
                    break;
                case 0x12:
                    (() => {
                        const pulseLength = tzx.getUint16(offset, true); offset += 2;
                        const pulseCount = tzx.getUint16(offset, true); offset += 2;
                        this.blocks.push({
                            'type': 'PureTone',
                            'pulseLength': pulseLength,
                            'pulseCount': pulseCount,
                            'generatePulses': (generator) => {
                                generator.addSegment(new ToneSegment(pulseLength, pulseCount));
                            }
                        });
                    })();
                    break;
                case 0x13:
                    (() => {
                        const pulseCount = tzx.getUint8(offset); offset += 1;
                        const pulseLengths = [];
                        for (let i = 0; i < pulseCount; i++) {
                            pulseLengths[i] = tzx.getUint16(offset + i*2, true);
                        }
                        this.blocks.push({
                            'type': 'PulseSequence',
                            'pulseLengths': pulseLengths,
                            'generatePulses': (generator) => {
                                generator.addSegment(new PulseSequenceSegment(pulseLengths));
                            }
                        });
                        offset += (pulseCount * 2);
                    })();
                    break;
                case 0x14:
                    (() => {
                        const zeroBitLength = tzx.getUint16(offset, true); offset += 2;
                        const oneBitLength = tzx.getUint16(offset, true); offset += 2;
                        const lastByteMask = tzx.getUint8(offset); offset += 1;
                        const pause = tzx.getUint16(offset, true); offset += 2;
                        const dataLength = tzx.getUint16(offset, true) | (tzx.getUint8(offset+2) << 16); offset += 3;
                        const blockData = new Uint8Array(data, offset, dataLength);
                        this.blocks.push({
                            'type': 'PureData',
                            'zeroBitLength': zeroBitLength,
                            'oneBitLength': oneBitLength,
                            'lastByteMask': lastByteMask,
                            'pause': pause,
                            'data': blockData,
                            'generatePulses': (generator) => {
                                generator.addSegment(new DataSegment(blockData, zeroBitLength, oneBitLength, lastByteMask));
                                if (pause) generator.addSegment(new PauseSegment(pause));
                            }
                        });
                        offset += dataLength;
                    })();
                    break;
                case 0x15:
                    (() => {
                        const tstatesPerSample = tzx.getUint16(offset, true); offset += 2;
                        const pause = tzx.getUint16(offset, true); offset += 2;
                        const lastByteMask = tzx.getUint8(offset); offset += 1;
                        const dataLength = tzx.getUint16(offset, true) | (tzx.getUint8(offset+2) << 16); offset += 3;
                        this.blocks.push({
                            'type': 'DirectRecording',
                            'tstatesPerSample': tstatesPerSample,
                            'lastByteMask': lastByteMask,
                            'pause': pause,
                            'data': new Uint8Array(data, offset, dataLength)
                        });
                        offset += dataLength;
                    })();
                    break;
                case 0x20:
                    (() => {
                        // TODO: handle pause length of 0 (= stop tape)
                        const pause = tzx.getUint16(offset, true); offset += 2;
                        this.blocks.push({
                            'type': 'Pause',
                            'pause': pause,
                            'generatePulses': (generator) => {
                                generator.addSegment(new PauseSegment(pause));
                            }
                        });
                    })();
                    break;
                case 0x21:
                    (() => {
                        const nameLength = tzx.getUint8(offset); offset += 1;
                        const nameBytes = new Uint8Array(data, offset, nameLength);
                        offset += nameLength;
                        const name = String.fromCharCode.apply(null, nameBytes);
                        this.blocks.push({
                            'type': 'GroupStart',
                            'name': name
                        });
                    })();
                    break;
                case 0x22:
                    (() => {
                        this.blocks.push({
                            'type': 'GroupEnd'
                        });
                    })();
                    break;
                case 0x23:
                    (() => {
                        const jumpOffset = tzx.getUint16(offset, true); offset += 2;
                        this.blocks.push({
                            'type': 'JumpToBlock',
                            'offset': jumpOffset
                        });
                    })();
                    break;
                case 0x24:
                    (() => {
                        const repeatCount = tzx.getUint16(offset, true); offset += 2;
                        this.blocks.push({
                            'type': 'LoopStart',
                            'repeatCount': repeatCount
                        });
                    })();
                    break;
                case 0x25:
                    (() => {
                        this.blocks.push({
                            'type': 'LoopEnd'
                        });
                    })();
                    break;
                case 0x26:
                    (() => {
                        const callCount = tzx.getUint16(offset, true); offset += 2;
                        const offsets = [];
                        for (let i = 0; i < callCount; i++) {
                            offsets[i] = tzx.getUint16(offset + i*2, true);
                        }
                        this.blocks.push({
                            'type': 'CallSequence',
                            'offsets': offsets
                        });
                        offset += (callCount * 2);
                    })();
                    break;
                case 0x27:
                    (() => {
                        this.blocks.push({
                            'type': 'ReturnFromSequence'
                        });
                    })();
                    break;
                case 0x28:
                    (() => {
                        const blockLength = tzx.getUint16(offset, true); offset += 2;
                        /* This is a silly block. Don't bother parsing it further. */
                        this.blocks.push({
                            'type': 'Select',
                            'data': new Uint8Array(data, offset, blockLength)
                        });
                        offset += blockLength;
                    })();
                    break;
                case 0x30:
                    (() => {
                        const textLength = tzx.getUint8(offset); offset += 1;
                        const textBytes = new Uint8Array(data, offset, textLength);
                        offset += textLength;
                        const text = String.fromCharCode.apply(null, textBytes);
                        this.blocks.push({
                            'type': 'TextDescription',
                            'text': text
                        });
                    })();
                    break;
                case 0x31:
                    (() => {
                        const displayTime = tzx.getUint8(offset); offset += 1;
                        const textLength = tzx.getUint8(offset); offset += 1;
                        const textBytes = new Uint8Array(data, offset, textLength);
                        offset += textLength;
                        const text = String.fromCharCode.apply(null, textBytes);
                        this.blocks.push({
                            'type': 'MessageBlock',
                            'displayTime': displayTime,
                            'text': text
                        });
                    })();
                    break;
                case 0x32:
                    (() => {
                        const blockLength = tzx.getUint16(offset, true); offset += 2;
                        this.blocks.push({
                            'type': 'ArchiveInfo',
                            'data': new Uint8Array(data, offset, blockLength)
                        });
                        offset += blockLength;
                    })();
                    break;
                case 0x33:
                    (() => {
                        const blockLength = tzx.getUint8(offset) * 3; offset += 1;
                        this.blocks.push({
                            'type': 'HardwareType',
                            'data': new Uint8Array(data, offset, blockLength)
                        });
                        offset += blockLength;
                    })();
                    break;
                case 0x35:
                    (() => {
                        const identifierBytes = new Uint8Array(data, offset, 10);
                        offset += 10;
                        const identifier = String.fromCharCode.apply(null, identifierBytes);
                        const dataLength = tzx.getUint32(offset, true);
                        this.blocks.push({
                            'type': 'CustomInfo',
                            'identifier': identifier,
                            'data': new Uint8Array(data, offset, dataLength)
                        });
                        offset += dataLength;
                    })();
                    break;
                case 0x5A:
                    (() => {
                        offset += 9;
                        this.blocks.push({
                            'type': 'Glue'
                        });
                    })();
                    break;
                default:
                    (() => {
                        /* follow extension rule: next 4 bytes = length of block */
                        const blockLength = tzx.getUint32(offset, true);
                        offset += 4;
                        this.blocks.push({
                            'type': 'unknown',
                            'data': new Uint8Array(data, offset, blockLength)
                        });
                        offset += blockLength;
                    })();
            }
        }

        this.nextBlockIndex = 0;
        this.loopToBlockIndex;
        this.repeatCount;
        this.callStack = [];

        this.pulseGenerator = new PulseGenerator((generator) => {
            const block = this.getNextMeaningfulBlock(false);
            if (!block) return false;
            block.generatePulses(generator);
            return true;
        });
    }

    getNextMeaningfulBlock(wrapAtEnd) {
        let startedAtZero = (this.nextBlockIndex === 0);
        while (true) {
            if (this.nextBlockIndex >= this.blocks.length) {
                if (startedAtZero || !wrapAtEnd) return null; /* have looped around; quit now */
                this.nextBlockIndex = 0;
                startedAtZero = true;
            }
            var block = this.blocks[this.nextBlockIndex];
            switch (block.type) {
                case 'StandardSpeedData':
                case 'TurboSpeedData':
                case 'PureTone':
                case 'PulseSequence':
                case 'PureData':
                case 'DirectRecording':
                case 'Pause':
                    /* found a meaningful block */
                    this.nextBlockIndex++;
                    return block;
                case 'JumpToBlock':
                    this.nextBlockIndex += block.offset;
                    break;
                case 'LoopStart':
                    this.loopToBlockIndex = this.nextBlockIndex + 1;
                    this.repeatCount = block.repeatCount;
                    this.nextBlockIndex++;
                    break;
                case 'LoopEnd':
                    this.repeatCount--;
                    if (this.repeatCount > 0) {
                        this.nextBlockIndex = this.loopToBlockIndex;
                    } else {
                        this.nextBlockIndex++;
                    }
                    break;
                case 'CallSequence':
                    /* push the future destinations (where to go on reaching a ReturnFromSequence block)
                        onto the call stack in reverse order, starting with the block immediately
                        after the CallSequence (which we go to when leaving the sequence) */
                    this.callStack.unshift(this.nextBlockIndex+1);
                    for (var i = block.offsets.length - 1; i >= 0; i--) {
                        this.callStack.unshift(this.nextBlockIndex + block.offsets[i]);
                    }
                    /* now visit the first destination on the list */
                    this.nextBlockIndex = this.callStack.shift();
                    break;
                case 'ReturnFromSequence':
                    this.nextBlockIndex = this.callStack.shift();
                    break;
                default:
                    /* not one of the types we care about; skip past it */
                    this.nextBlockIndex++;
            }
        }
    }

    getNextLoadableBlock() {
        while (true) {
            var block = this.getNextMeaningfulBlock(true);
            if (!block) return null;
            if (block.type == 'StandardSpeedData' || block.type == 'TurboSpeedData') {
                return block.data;
            }
            /* FIXME: avoid infinite loop if the TZX file consists only of meaningful but non-loadable blocks */
        }
    }
}
