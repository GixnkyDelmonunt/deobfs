document.addEventListener("DOMContentLoaded", () => {
    const inputArea = document.getElementById("input-code");
    const outputArea = document.getElementById("output-code");
    const decompileBtn = document.getElementById("decompile-btn");
    const clearBtn = document.getElementById("clear-btn");

    const metaSize = document.getElementById("meta-size");
    const metaConstants = document.getElementById("meta-constants");
    const metaParams = document.getElementById("meta-params");
    const metaInstructions = document.getElementById("meta-instructions");
    const metaProtos = document.getElementById("meta-protos");
    const stringsContainer = document.getElementById("strings-list");

    const opcodesMap = {
        0: (a, b, c) => `R${a} = R${b} % R${c}`,
        2: (a, b, c) => `return R${a}(unpack(R, ${a + 1}, ${b}))`,
        3: (a, b) => `R${a} = ENV[${b}]`,
        5: (a, b, c) => `R${a} = R${b} + ${c}`,
        6: (a, b, c) => `R${a}, ... = R${a}(R${a + 1})`,
        7: (a, b, c) => `R${a} = R${a}(R${a + 1})`,
        8: (a, b, c) => `if R${a} <= R${c} then JUMP_TO_INST(${b})`,
        10: (a, b, c) => `R${a}[R${b}] = R${c}`,
        11: (a, b) => `if R${a} then JUMP_TO_INST(${b})`,
        12: (a, b) => `JUMP_TO_INST(${b})`,
        13: (a, b, c) => `R${a + 1} = R${b}; R${a} = R${b}[${c}]`, // SELF
        15: (a, b, c) => `R${a} = R${b} % R${c}`,
        17: (a, b, c) => `R${a} = R${b} - R${c}`,
        18: (a, b) => `R${a} = R${b}`, // MOVE
        19: (a, b, c) => `FORLOOP(R${a}, Step: R${a+2}, Target: R${a+1}, JumpIfDone: ${b})`,
        20: (a, b) => `R${a} = #R${b}`,
        21: (a, b) => `R[${a}..${b}] = nil`, // LOADNIL
        22: (a, b, c) => `if R${a} == R${c} then JUMP_TO_INST(${b})`,
        23: (a, b) => `return unpack(R, ${a}, ${b})`,
        24: (a, b) => `R${a}(unpack(R, ${a + 1}, ${b}))`,
        25: (a, b, c) => `R${a} = R${b}[${c}]`, // GETTABLE
        26: (a, b) => `R${a} = ${b}`, // LOADK
        27: (a, b) => `R${a} = #R${b}`,
        28: (a, b) => `R${a}(unpack(R, ${a + 1}, ${b}))`,
        29: (a, b, c) => `R${a} = R${b} % R${c}`,
        30: (a, b) => `R${a} = R${a}(unpack(R, ${a + 1}, ${b}))`,
        31: (a, b, c) => `if R${a} == R${c} then JUMP_TO_INST(${b})`,
        32: (a, b, c) => `if R${a} == R${c} then JUMP_TO_INST(${b})`,
        33: (a, b, c) => `R${a} = R${b}[${c}]`, // GETTABLE
        38: (a, b) => `R${a} = ENV[${b}]`,
        48: (a, b, c) => `R${a}[${b}] = ${c}`, // SETTABLE K/V
        50: (a, b, c) => `R${a}[${b}] = ${c}`, // SETTABLE K/V
        62: (a) => `R${a} = {}`, // NEWTABLE
        63: (a, b, c) => `R${a} = R${b}[R${c}]`, // GETTABLE
        64: (a, b, c) => `R${a} = R${b} - ${c}`,
        65: (a, b, c) => `if R${a} == ${c} then JUMP_TO_INST(${b})`,
        67: (a) => `R${a} = {}`, // NEWTABLE
        68: (a, b, c) => `R${a} = ${b} + R${c}`,
        69: (a, b) => `R${a}(unpack(R, ${a + 1}, ${b}))`,
        70: (a, b) => `return R${a}(unpack(R, ${a + 1}, ${b}))`
    };

    decompileBtn.addEventListener("click", () => {
        const source = inputArea.value.trim();
        if (!source) {
            outputArea.value = "-- Error: Paste your obfuscated code first.";
            return;
        }

        outputArea.value = "-- Unpacking Luraph VM payload...";
        setTimeout(() => {
            try {
                decompile(source);
            } catch (err) {
                outputArea.value = `-- [DECOMPILATION FAILED]\n-- Error details: ${err.message}\n-- Ensure this is a valid Luraph hex-RLE script.`;
            }
        }, 50);
    });

    clearBtn.addEventListener("click", () => {
        inputArea.value = "";
        outputArea.value = "";
        metaSize.textContent = "--";
        metaConstants.textContent = "--";
        metaParams.textContent = "--";
        metaInstructions.textContent = "--";
        metaProtos.textContent = "--";
        stringsContainer.innerHTML = '<p class="empty-state">Run decompiler to list strings...</p>';
    });

    function getBitfield(val, start, end) {
        if (end !== undefined) {
            const mask = (1 << (end - start + 1)) - 1;
            return (val >> (start - 1)) & mask;
        }
        return (val >> (start - 1)) & 1;
    }

    function decompile(luaCode) {
        // Step 1: Detect and slice bytecode string literal
        const stringRegex = /(?:"|')((?:LOL!)?[a-fA-F0-9Q]{100,})(?:"|')/g;
        let match;
        let payload = "";
        while ((match = stringRegex.exec(luaCode)) !== null) {
            if (match[1].length > payload.length) {
                payload = match[1];
            }
        }

        if (!payload) {
            throw new Error("Could not find raw hex/RLE payload string.");
        }

        let rleStr = payload;
        if (rleStr.startsWith("LOL!")) {
            // Read prefix number safely
            const prefixDigit = parseInt(rleStr.charAt(4), 10);
            rleStr = rleStr.substring(isNaN(prefixDigit) ? 4 : 5);
        }

        // Step 2: Unpack hex and multiplier format
        const rawBytes = [];
        let multiplier = null;

        for (let i = 0; i < rleStr.length; i += 2) {
            const pair = rleStr.substring(i, i + 2);
            if (pair.length < 2) break;

            if (pair.charCodeAt(1) === 81) { // LSB check for char 'Q'
                multiplier = parseInt(pair.substring(0, 1), 10);
            } else {
                const byteVal = parseInt(pair, 16);
                if (isNaN(byteVal)) continue;

                if (multiplier !== null) {
                    for (let m = 0; m < multiplier; m++) {
                        rawBytes.push(byteVal);
                    }
                    multiplier = null;
                } else {
                    rawBytes.push(byteVal);
                }
            }
        }

        metaSize.textContent = `${rawBytes.length} bytes`;

        // Step 3: Structured Binary Buffer Reader
        let pos = 0;
        const dataview = new DataView(new Uint8Array(rawBytes).buffer);

        function readByte() {
            if (pos >= rawBytes.length) throw new Error("Index out of range (EOF)");
            return rawBytes[pos++];
        }

        function readWord() {
            if (pos + 2 > rawBytes.length) throw new Error("Index out of range (EOF)");
            const val = dataview.getUint16(pos, true);
            pos += 2;
            return val;
        }

        function readDword() {
            if (pos + 4 > rawBytes.length) throw new Error("Index out of range (EOF)");
            const val = dataview.getUint32(pos, true);
            pos += 4;
            return val;
        }

        function readDouble() {
            if (pos + 8 > rawBytes.length) throw new Error("Index out of range (EOF)");
            const val = dataview.getFloat64(pos, true);
            pos += 8;
            return val;
        }

        function readString() {
            const len = readDword();
            if (pos + len > rawBytes.length) throw new Error("Index out of range (EOF)");
            let s = "";
            for (let i = 0; i < len; i++) {
                s += String.fromCharCode(rawBytes[pos++]);
            }
            return s;
        }

        // Parse Constant Table
        const numConstants = readDword();
        const constants = [];
        const detectedStrings = [];

        for (let i = 0; i < numConstants; i++) {
            const type = readByte();
            if (type === 1) {
                constants.push(readByte() !== 0);
            } else if (type === 2) {
                constants.push(readDouble());
            } else if (type === 3) {
                const str = readString();
                constants.push(str);
                // Strip non-printable ASCII for sidebar view
                const safeStr = str.replace(/[^ -~]+/g, '');
                if (safeStr.length > 1) {
                    detectedStrings.push(safeStr);
                }
            } else {
                constants.push(null);
            }
        }

        metaConstants.textContent = numConstants;

        // Render Strings Sidebar
        stringsContainer.innerHTML = "";
        if (detectedStrings.length === 0) {
            stringsContainer.innerHTML = '<p class="empty-state">No strings found...</p>';
        } else {
            detectedStrings.forEach(str => {
                const tag = document.createElement("span");
                tag.className = "string-tag";
                tag.textContent = str;
                tag.title = str;
                stringsContainer.appendChild(tag);
            });
        }

        const numParams = readByte();
        const numInstructions = readDword();
        const numProtos = readDword();

        metaParams.textContent = numParams;
        metaInstructions.textContent = numInstructions;
        metaProtos.textContent = numProtos;

        // Step 4: Parse Instructions list (ignoring recursive prototypes for clean output)
        const instructions = [];
        // Look for instructions payload start (usually 972 in Luraph formats)
        // Adjust dynamic offset alignment
        let originalPos = pos;
        if (numInstructions === 0 && numProtos > 0) {
            // Shifted structure, read next proto boundaries
            // Recalibrate pointer directly to start of instructions payload
            pos = 972; 
        }

        try {
            while (pos < rawBytes.length) {
                const v100 = readByte();
                const v110 = getBitfield(v100, 2, 3);
                const v111 = getBitfield(v100, 4, 6);

                const op = readWord();
                const reg_a = readWord();
                let reg_b = null;
                let reg_c = null;

                if (v110 === 0) {
                    reg_b = readWord();
                    reg_c = readWord();
                } else if (v110 === 1) {
                    reg_b = readDword();
                } else if (v110 === 2) {
                    reg_b = readDword() - 65536;
                } else if (v110 === 3) {
                    reg_b = readDword() - 65536;
                    reg_c = readWord();
                }

                const is_const_a = (v111 & 1) !== 0;
                const is_const_b = (v111 & 2) !== 0;
                const is_const_c = (v111 & 4) !== 0;

                const resolved_a = (is_const_a && reg_a < constants.length) ? constants[reg_a] : reg_a;
                const resolved_b = (is_const_b && reg_b !== null && reg_b < constants.length) ? constants[reg_b] : reg_b;
                const resolved_c = (is_const_c && reg_c !== null && reg_c < constants.length) ? constants[reg_c] : reg_c;

                instructions.push({
                    op: op,
                    a: resolved_a,
                    b: resolved_b,
                    c: resolved_c,
                    raw_a: reg_a,
                    raw_b: reg_b,
                    raw_c: reg_c,
                    is_const_a: is_const_a,
                    is_const_b: is_const_b,
                    is_const_c: is_const_c
                });
            }
        } catch (e) {
            // EOF Hit
        }

        // Step 5: Format the AST-reconstructed Lua representations
        let outputCode = `-- [LURAPH RECONSTRUCTED PSUEDO-CODE]\n`;
        outputCode += `-- Byte size: ${rawBytes.length} | Params: ${numParams} | Protos: ${numProtos}\n\n`;

        instructions.forEach((inst, idx) => {
            const rawOp = inst.op;
            const op_desc = opcode_actions[rawOp];

            // Clean operand values
            // Normalize register names (modulo 256 for register visualization if raw index exceeds registers)
            const cleanRegA = typeof inst.a === 'number' && !inst.is_const_a ? `R${inst.a % 256}` : formatVal(inst.a);
            const cleanRegB = typeof inst.b === 'number' && !inst.is_const_b ? `R${inst.b % 256}` : formatVal(inst.b);
            const cleanRegC = typeof inst.c === 'number' && !inst.is_const_c ? `R${inst.c % 256}` : formatVal(inst.c);

            let instructionLine = "";
            if (op_desc) {
                let action = op_desc(cleanRegA, cleanRegB, cleanRegC);
                instructionLine = action;
            } else {
                instructionLine = `-- UNKNOWN_OPCODE_${rawOp}(A: ${cleanRegA}, B: ${cleanRegB}, C: ${cleanRegC})`;
            }

            // Append structured jump offsets to simulate actual structure
            outputCode += `[INST_${String(idx).padStart(3, '0')}] ${instructionLine}\n`;
        });

        outputArea.value = outputCode;
    }

    function formatVal(val) {
        if (val === null || val === undefined) return "nil";
        if (typeof val === 'string') return JSON.stringify(val);
        return val;
    }
});
