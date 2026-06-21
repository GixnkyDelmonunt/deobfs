/**
 * Institutional Statistical Arbitrage Decompiler Core v1.1
 * Specialized for LuaVM/Luraph Bytecode Reconstruction
 */

class BinaryReader {
    /**
     * @param {ArrayBuffer} arrayBuffer 
     */
    constructor(arrayBuffer) {
        this.data = new DataView(arrayBuffer);
        this.pos = 0;
        this.length = arrayBuffer.byteLength;
    }

    readByte() {
        if (this.pos >= this.length) return 0;
        const val = this.data.getUint8(this.pos);
        this.pos += 1;
        return val;
    }

    readWord() {
        if (this.pos + 2 > this.length) return 0;
        const val = this.data.getUint16(this.pos, true); // Little-endian
        this.pos += 2;
        return val;
    }

    readDword() {
        if (this.pos + 4 > this.length) return 0;
        const val = this.data.getUint32(this.pos, true); // Little-endian
        this.pos += 4;
        return val;
    }

    readDouble() {
        if (this.pos + 8 > this.length) return 0.0;
        const val = this.data.getFloat64(this.pos, true); // Little-endian
        this.pos += 8;
        return val;
    }

    readString() {
        const len = this.readDword();
        if (this.pos + len > this.length) return "";
        const bytes = new Uint8Array(this.data.buffer, this.pos, len);
        this.pos += len;
        
        let str = "";
        for (let i = 0; i < len; i++) {
            str += String.fromCharCode(bytes[i]);
        }
        return str;
    }

    isEof() {
        return this.pos >= this.length;
    }
}

class LuraphDecoder {
    /**
     * Decodes the custom RLE/hex payload embedded in the Lua obfuscator.
     * @param {string} packedStr 
     * @returns {Uint8Array}
     */
    static decodePayload(packedStr) {
        // Skip the initial header prefix (typically "LOL!" or first 4 characters)
        const payload = packedStr.substring(4);
        const bytes = [];
        let repeatCount = null;

        for (let i = 0; i < payload.length; i += 2) {
            const pair = payload.substring(i, i + 2);
            if (pair.length < 2) continue;

            // Character 81 is 'Q' in ASCII, signaling a repeat count
            if (pair.charCodeAt(1) === 81) {
                repeatCount = parseInt(pair.charAt(0), 10);
            } else {
                const byteValue = parseInt(pair, 16);
                if (isNaN(byteValue)) continue;

                if (repeatCount !== null) {
                    for (let r = 0; r < repeatCount; r++) {
                        bytes.push(byteValue);
                    }
                    repeatCount = null;
                } else {
                    bytes.push(byteValue);
                }
            }
        }
        return new Uint8Array(bytes);
    }

    /**
     * Parses the Luraph bytecode stream recursively.
     * @param {BinaryReader} reader 
     * @param {number} depth 
     * @returns {object}
     */
    static parsePrototype(reader, depth = 0) {
        const numConstants = reader.readDword();
        const constants = [];
        for (let i = 0; i < numConstants; i++) {
            const type = reader.readByte();
            let val = null;
            if (type === 1) {
                val = (reader.readByte() !== 0);
            } else if (type === 2) {
                val = reader.readDouble();
            } else if (type === 3) {
                val = reader.readString();
            }
            constants.push(val);
        }

        const numParams = reader.readByte();
        const numInstructions = reader.readDword();
        const instructions = [];

        // Protection check against malformed or obfuscated extreme sizes
        const safeInstCount = Math.min(numInstructions, 10000);

        for (let i = 0; i < safeInstCount; i++) {
            if (reader.isEof()) break;

            const v100 = reader.readByte();
            const v110 = (v100 >> 1) & 3; // Bits 2-3 determine instruction size/structure
            const v111 = (v100 >> 3) & 7; // Bits 4-6 determine constant flags

            const op = reader.readWord();
            const regA = reader.readWord();
            let regB = null;
            let regC = null;

            if (v110 === 0) {
                regB = reader.readWord();
                regC = reader.readWord();
            } else if (v110 === 1) {
                regB = reader.readDword();
            } else if (v110 === 2) {
                regB = reader.readDword() - 65536;
            } else if (v110 === 3) {
                regB = reader.readDword() - 65536;
                regC = reader.readWord();
            }

            // Map constant resolution flags
            const isConstA = (v111 & 1) !== 0;
            const isConstB = (v111 & 2) !== 0;
            const isConstC = (v111 & 4) !== 0;

            instructions.push({
                op,
                regA,
                regB,
                regC,
                isConstA,
                isConstB,
                isConstC,
                rawByte: v100
            });
        }

        const numProtos = reader.readDword();
        const protos = [];
        const safeProtoCount = Math.min(numProtos, 500);

        for (let i = 0; i < safeProtoCount; i++) {
            if (reader.isEof()) break;
            protos.push(LuraphDecoder.parsePrototype(reader, depth + 1));
        }

        return {
            constants,
            numParams,
            instructions,
            protos,
            depth
        };
    }
}

class LuraphDecompiler {
    constructor() {
        // Map Virtual Machine opcodes to concrete Lua operations
        this.opcodes = {
            0: { name: "MOD", format: "R{A} = R{B} % {C}" },
            1: { name: "MOD_REG", format: "R{A} = R{B} % R{C}" },
            2: { name: "RETURN_CALL", format: "return R{A}(unpack(REG, {A}+1, {B}))" },
            3: { name: "GETGLOBAL", format: "R{A} = ENV[{B}]" },
            5: { name: "ADD", format: "R{A} = R{B} + {C}" },
            6: { name: "CALL_MULT", format: "R{A}, ... = R{A}(REG[{A}+1])" },
            7: { name: "CALL_ONE", format: "R{A} = R{A}(REG[{A}+1])" },
            8: { name: "JUMP_LE", format: "if R{A} <= {C} then JUMP {B}" },
            10: { name: "SETTABLE_REG", format: "R{A}[R{B}] = R{C}" },
            11: { name: "JUMP_TEST", format: "if R{A} then JUMP {B}" },
            12: { name: "JUMP", format: "JUMP {B}" },
            13: { name: "SELF", format: "R{A}+1 = R{B}; R{A} = R{B}[{C}]" },
            15: { name: "MOD_REG_2", format: "R{A} = R{B} % R{C}" },
            17: { name: "SUB", format: "R{A} = R{B} - R{C}" },
            18: { name: "MOVE", format: "R{A} = R{B}" },
            19: { name: "FORLOOP", format: "FORLOOP R{A} to {B}" },
            20: { name: "LEN", format: "R{A} = #R{B}" },
            21: { name: "LOADNIL", format: "R{A}..{B} = nil" },
            22: { name: "JUMP_EQ_REG", format: "if R{A} == {C} then JUMP {B}" },
            23: { name: "RETURN_UNPACK", format: "return unpack(REG, {A}, {B})" },
            25: { name: "GETTABLE", format: "R{A} = R{B}[{C}]" },
            26: { name: "LOADK", format: "R{A} = {B}" },
            29: { name: "MOD_REG_3", format: "R{A} = R{B} % R{C}" },
            30: { name: "CALL_UNPACK", format: "R{A} = R{A}(unpack(REG, {A}+1, {B}))" },
            31: { name: "JUMP_EQ_CONST", format: "if R{A} == {C} then JUMP {B}" },
            32: { name: "JUMP_EQ_REG_2", format: "if R{A} == {C} then JUMP {B}" },
            33: { name: "GETTABLE_2", format: "R{A} = R{B}[{C}]" },
            38: { name: "GETGLOBAL_2", format: "R{A} = ENV[{B}]" },
            48: { name: "OP_48", format: "OP_48 R{A} {B} {C}" },
            50: { name: "OP_50", format: "OP_50 R{A} {B} {C}" },
            62: { name: "NEWTABLE", format: "R{A} = {}" },
            63: { name: "GETTABLE_REG", format: "R{A} = R{B}[R{C}]" },
            64: { name: "SUB_CONST", format: "R{A} = R{B} - {C}" },
            65: { name: "JUMP_EQ_CONST_2", format: "if R{A} == {C} then JUMP {B}" },
            67: { name: "NEWTABLE_2", format: "R{A} = {}" },
            68: { name: "ADD_REG", format: "R{A} = {B} + R{C}" },
            69: { name: "CALL_VOID", format: "R{A}(unpack(REG, {B}, {C}))" },
            70: { name: "RETURN_CALL_2", format: "return R{A}(unpack(REG, {B}, {C}))" }
        };
    }

    /**
     * Resolves operands to either registers or constant-pool values based on flags.
     * @param {object} inst 
     * @param {Array} constants 
     * @returns {object}
     */
    resolveOperand(inst, constants) {
        const resolved = {
            a: inst.regA,
            b: inst.regB,
            c: inst.regC
        };

        if (inst.isConstA && inst.regA < constants.length) {
            resolved.a = constants[inst.regA];
        }
        if (inst.isConstB && inst.regB !== null && inst.regB < constants.length) {
            resolved.b = constants[inst.regB];
        }
        if (inst.isConstC && inst.regC !== null && inst.regC < constants.length) {
            resolved.c = constants[inst.regC];
        }

        return resolved;
    }

    /**
     * Translates a parsed prototype structure into readable Lua representations.
     * @param {object} proto 
     * @param {string} protoName 
     * @returns {string}
     */
    decompilePrototype(proto, protoName = "main") {
        let output = `-- Function: ${protoName} (Params: ${proto.numParams})\n`;
        const indent = "    ";

        // Declare any nested function prototypes
        if (proto.protos.length > 0) {
            output += `-- Nested closures detected (${proto.protos.length})\n`;
            proto.protos.forEach((subProto, i) => {
                output += this.decompilePrototype(subProto, `${protoName}_closure_${i}`);
                output += "\n";
            });
        }

        // Print Constant Pool for debugging / clarity
        output += `-- Constant Pool:\n`;
        proto.constants.forEach((c, idx) => {
            output += `--   [${idx}]: ${typeof c === 'string' ? JSON.stringify(c) : c}\n`;
        });
        output += `\n`;

        // Decompile instruction stream
        output += `function ${protoName}(...)\n`;
        
        let ip = 0;
        const totalInsts = proto.instructions.length;

        while (ip < totalInsts) {
            const inst = proto.instructions[ip];
            const opInfo = this.opcodes[inst.op];
            const operands = this.resolveOperand(inst, proto.constants);

            let line = `[IP: ${ip.toString().padStart(3, '0')}] `;
            if (opInfo) {
                let format = opInfo.format;
                
                // Format replacement helpers
                format = format.replace(/{A}/g, typeof operands.a === 'string' ? `"${operands.a}"` : operands.a);
                format = format.replace(/{B}/g, typeof operands.b === 'string' ? `"${operands.b}"` : operands.b);
                format = format.replace(/{C}/g, typeof operands.c === 'string' ? `"${operands.c}"` : operands.c);
                
                // Opcode mapping specific exceptions (C_OR_D fields)
                format = format.replace(/{C_OR_D}/g, operands.c !== null ? (typeof operands.c === 'string' ? `"${operands.c}"` : operands.c) : "nil");

                line += format;
            } else {
                line += `OP_${inst.op} A=${operands.a} B=${operands.b} C=${operands.c}`;
            }

            output += indent + line + "\n";
            ip++;
        }

        output += `end\n`;
        return output;
    }

    /**
     * Extracts the primary payload argument from the v15() container.
     * @param {string} sourceCode 
     * @returns {string|null}
     */
    extractPayloadString(sourceCode) {
        // Matches the main string inside v15("payload", env, ...)
        const match = sourceCode.match(/v15\s*\(\s*"([^"]+)"/);
        if (match && match[1]) {
            return match[1];
        }
        // Fallback match for single-quoted payload strings
        const fallbackMatch = sourceCode.match(/v15\s*\(\s*'([^']+)'/);
        if (fallbackMatch && fallbackMatch[1]) {
            return fallbackMatch[1];
        }
        return null;
    }

    /**
     * Primary API execution path
     * @param {string} fullSource 
     * @returns {string}
     */
    decompile(fullSource) {
        try {
            const packedStr = this.extractPayloadString(fullSource);
            if (!packedStr) {
                return "-- Error: Failed to find compressed bytecode string inside the v15() call wrapper.";
            }

            const binaryData = LuraphDecoder.decodePayload(packedStr);
            const reader = new BinaryReader(binaryData.buffer);
            
            const rootProto = LuraphDecoder.parsePrototype(reader);
            
            let result = `-- Decompiled with Luraph Static Analyzer Engine\n\n`;
            result += this.decompilePrototype(rootProto);
            return result;
        } catch (err) {
            return `-- Error encountered during bytecode translation:\n-- ${err.message}\n-- Stack:\n${err.stack}`;
        }
    }
}

// Global entry point initialization
window.LuraphDecompiler = LuraphDecompiler;
