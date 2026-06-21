document.addEventListener("DOMContentLoaded", () => {
    const inputArea = document.getElementById("obfuscated-code");
    const outputArea = document.getElementById("output-code");
    const deobfuscateBtn = document.getElementById("deobfuscate-btn");
    const clearBtn = document.getElementById("clear-btn");

    deobfuscateBtn.addEventListener("click", () => {
        const input = inputArea.value.trim();
        if (!input) {
            outputArea.value = "-- Please enter some obfuscated Lua code.";
            return;
        }

        outputArea.value = "-- Unpacking bytecode. Please wait...";
        setTimeout(() => {
            try {
                const result = performUnpacking(input);
                outputArea.value = result;
            } catch (err) {
                outputArea.value = `-- An error occurred during decoding:\n-- ${err.message}`;
            }
        }, 50);
    });

    clearBtn.addEventListener("click", () => {
        inputArea.value = "";
        outputArea.value = "";
    });

    /**
     * Extracts and decodes the packed bytecode payload to read metadata and constant tables.
     */
    function performUnpacking(rawInput) {
        // Step 1: Find the longest contiguous string literal which holds the bytecode
        const stringRegex = /(?:"|')((?:LOL!)?[a-fA-F0-9Q]{100,})(?:"|')/g;
        let match;
        let bytecodePayload = "";
        
        while ((match = stringRegex.exec(rawInput)) !== null) {
            if (match[1].length > bytecodePayload.length) {
                bytecodePayload = match[1];
            }
        }

        if (!bytecodePayload) {
            return "-- Heuristic search error:\n-- Could not find a valid bytecode hex payload (e.g., 'LOL!...' string).";
        }

        // Strip prefix "LOL!5" or variations
        let cleanPayload = bytecodePayload;
        if (cleanPayload.startsWith("LOL!")) {
            cleanPayload = cleanPayload.substring(5); 
        }

        // Step 2: Unpack hex and resolve RLE (multiplier Q characters)
        const rawBytes = [];
        let multiplier = null;

        for (let i = 0; i < cleanPayload.length; i += 2) {
            const pair = cleanPayload.substring(i, i + 2);
            if (pair.length < 2) break;

            if (pair.charCodeAt(1) === 81) { // 'Q'
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

        if (rawBytes.length === 0) {
            return "-- Unpacking error: Byte resolution failed to yield results.";
        }

        // Step 3: Parse standard VM bytecode blocks (Constants Table structure)
        let pos = 0;
        const arrayBuffer = new Uint8Array(rawBytes).buffer;
        const view = new DataView(arrayBuffer);

        function readByte() {
            if (pos >= rawBytes.length) throw new Error("Index out of range (EOF)");
            return rawBytes[pos++];
        }

        function readDword() {
            if (pos + 4 > rawBytes.length) throw new Error("Index out of range (EOF)");
            const val = view.getUint32(pos, true);
            pos += 4;
            return val;
        }

        function readDouble() {
            if (pos + 8 > rawBytes.length) throw new Error("Index out of range (EOF)");
            const val = view.getFloat64(pos, true);
            pos += 8;
            return val;
        }

        function readString() {
            const len = readDword();
            if (pos + len > rawBytes.length) throw new Error("Index out of range (EOF)");
            let str = "";
            for (let i = 0; i < len; i++) {
                str += String.fromCharCode(rawBytes[pos++]);
            }
            return str;
        }

        try {
            const numConstants = readDword();
            const constants = [];
            
            for (let i = 0; i < numConstants; i++) {
                const type = readByte();
                if (type === 1) {
                    constants.push(readByte() !== 0);
                } else if (type === 2) {
                    constants.push(readDouble());
                } else if (type === 3) {
                    constants.push(readString());
                } else {
                    constants.push(null);
                }
            }

            const numParams = readByte();
            const numInstructions = readDword();
            const numProtos = readDword();

            // Constructing output
            let output = `-- [UNPACKED LUA BYTECODE SUMMARY]\n`;
            output += `-- Total Bytecode Size: ${rawBytes.length} bytes\n`;
            output += `-- Main Function Parameters: ${numParams}\n`;
            output += `-- Main Function Instructions: ${numInstructions}\n`;
            output += `-- Sub-Prototypes Count: ${numProtos}\n\n`;

            output += `-- [CONSTANT POOL VALUES]\n`;
            constants.forEach((val, index) => {
                let displayVal = val;
                if (typeof val === 'string') {
                    displayVal = JSON.stringify(val);
                }
                output += `constant[${index}] = ${displayVal}\n`;
            });

            return output;

        } catch (err) {
            // Fallback: If table parsing misaligned, attempt raw ASCII string extraction
            let fallbackOutput = `-- [PARSER MISALIGNMENT - FALLING BACK TO RAW EXTRACTION]\n`;
            fallbackOutput += `-- Structured parsing hit limits: ${err.message}\n`;
            fallbackOutput += `-- Extracting sequential ASCII strings instead:\n\n`;

            let tempStr = "";
            for (let i = 0; i < rawBytes.length; i++) {
                const b = rawBytes[i];
                if (b >= 32 && b <= 126) {
                    tempStr += String.fromCharCode(b);
                } else {
                    if (tempStr.length >= 3) {
                        fallbackOutput += `"${tempStr}"\n`;
                    }
                    tempStr = "";
                }
            }
            if (tempStr.length >= 3) {
                fallbackOutput += `"${tempStr}"\n`;
            }

            return fallbackOutput;
        }
    }
});
