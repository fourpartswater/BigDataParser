const fs = require('fs');
const pako = require('pako');
const path = require('path');
const inquirer = require('inquirer');
const cliProgress = require('cli-progress');
const processCSV = require('./processCSV');

const funtionTable = {
    'Int8': 'writeInt8',
    'Int16': 'writeInt16LE',
    'Int32': 'writeInt32LE',
    'Uint8': 'writeUInt8',
    'Uint16': 'writeUInt16LE',
    'Uint32': 'writeUInt32LE',
    'Float32': 'writeFloatLE',
};

function getRowGetter(header, view, offset) {
    return i => {
        const ret = {};
        header.order.forEach(column => {
            if (header.columns[column].type === 'Float32') {
                ret[column] = view.readFloatLE(offset + i * header.rowSize + header.columns[column].offset);
            } else if (header.columns[column].type === 'Uint32') {
                ret[column] = view.readUInt32LE(offset + i * header.rowSize + header.columns[column].offset);
            } else if (header.columns[column].type === 'Int32') {
                ret[column] = view.readInt32LE(offset + i * header.rowSize + header.columns[column].offset);
            } else {
                const sOff = offset + i * header.rowSize + header.columns[column].offset;
                const size = view.readUInt8(sOff);
                ret[column] = '';
                for (let i = 0; i < size; ++i) {
                    ret[column] += String.fromCharCode(view.readUInt8(sOff + i + 1));
                }
            }
        });
        return ret;
    }
}

async function main(argv) {
    if (argv.length < 4) {
        if (argv.length < 3 || (argv[2] !== '-h' && argv[2] !== '--help')) {
            console.error('Not enough arguments.');
        }
        console.log('Usage: generateBean [INPUT_FILE] [OUTPUT_FILE]');
        return;
    }

    const input = path.resolve(process.cwd(), argv[2]);
    const output = path.resolve(process.cwd(), argv[3]);

    const totalFileSize = fs.statSync(input).size;
    const progressBar = new cliProgress.Bar({
        format: '{task}: [{bar}] {percentage}% | ETA: {eta_formatted} | Elapsed: {duration_formatted}',
        fps: 2,
        etaBuffer: Math.floor(totalFileSize / 10),
    }, cliProgress.Presets.shades_classic);

    const meta = {
        columnOrder: null,
        columns: {},
    };

    progressBar.start(totalFileSize, 0, { task: 'Soaking beans' });

    let value;
    await processCSV(input, null, (data, csvHeader, bytesRead) => {
        if (csvHeader) {
            meta.columnOrder = csvHeader;
            csvHeader.forEach(column => {
                meta.columns[column] = {
                    number: {
                        min: Number.MAX_SAFE_INTEGER,
                        max: Number.MIN_SAFE_INTEGER,
                        isFloat: false,
                        count: 0,
                    },
                    string: {
                        min: Number.MAX_SAFE_INTEGER,
                        max: Number.MIN_SAFE_INTEGER,
                        count: 0,
                    },
                };
            });
        }

        if (data) {
            Object.keys(data).forEach(column => {
                if (isNaN(data[column])) {
                    value = data[column];
                    ++meta.columns[column].string.count;
                    meta.columns[column].string.min = Math.min(meta.columns[column].string.min, value.length);
                    meta.columns[column].string.max = Math.max(meta.columns[column].string.max, value.length);
                } else {
                    value = parseFloat(data[column]);
                    ++meta.columns[column].number.count;
                    meta.columns[column].number.min = Math.min(meta.columns[column].number.min, value);
                    meta.columns[column].number.max = Math.max(meta.columns[column].number.max, value);
                    meta.columns[column].number.isFloat = meta.columns[column].number.isFloat || !Number.isInteger(value);
                }
            });
        }

        progressBar.update(bytesRead);
    });

    progressBar.stop();

    const questions = [];
    Object.keys(meta.columns).forEach(column => {
        if (meta.columns[column].number.count > 0 && meta.columns[column].string.count > 0) {
            questions.push({
                type: 'confirm',
                name: column,
                message: `Is the type of column [${column}] numeric?`,
                default: meta.columns[column].number.count > meta.columns[column].string.count,
            });
        }
    });

    let userTypes = {};
    if (questions.length) {
        userTypes = await inquirer.prompt(questions);
    }

    const columns = {};
    let rowCount = Number.MAX_SAFE_INTEGER;
    Object.keys(meta.columns).forEach(column => {
        if (userTypes[column] || (meta.columns[column].number.count > 0 && meta.columns[column].string.count === 0)) {
            if (meta.columns[column].number.isFloat) {
                columns[column] = {
                    type: 'Float32',
                    size: 4,
                };
            } else {
                columns[column] = {
                    type: meta.columns[column].number.min < 0 ? 'Int32' : 'Uint32',
                    size: 4,
                };
            }
            rowCount = Math.min(rowCount, meta.columns[column].number.count);
        } else {
            const size = meta.columns[column].string.max + 1;
            columns[column] = {
                type: 'string',
                size: Math.min(4 * Math.floor(size / 4) + 4 * Math.min(1, size % 4), 256), // max string length is 255 + 1
            };
            rowCount = Math.min(rowCount, meta.columns[column].string.count);
        }
    });

    const columnOrder = meta.columnOrder.slice().sort((a, b) => {
        if (columns[a].type === columns[b].type) {
            return 0;
        }

        if (columns[a].type === 'string') {
            return 1;
        }

        if (columns[b].type === 'string') {
            return -1;
        }

        if (columns[a].type === 'Float32') {
            return 1;
        }

        return -1;
    });

    let rowSize = 0;
    columnOrder.forEach(column => {
        columns[column].offset = rowSize;
        rowSize += columns[column].size;
    });



    progressBar.start(totalFileSize, 0, { task: 'Preparing beans' });

    const rowsBuffer = Buffer.alloc(rowSize * rowCount);
    const rowBuffer = Buffer.alloc(rowSize);
    let offset = 0;
    let add;
    let rowOffset;
    let i;
    let n;
    rowCount = 0;
    await processCSV(input, null, (data, csvHeader, bytesRead) => {
        if (data) {
            add = true;
            rowOffset = 0;
            rowBuffer.fill(0);
            columnOrder.forEach(column => {
                if (columns[column].type === 'string') {
                    n = Math.min(data[column].length, 255);
                    rowBuffer.writeUInt8(n, rowOffset);
                    for (i = 0; i < n; ++i) {
                        rowBuffer.writeUInt8(data[column].charCodeAt(i), rowOffset + i + 1);
                    }
                } else {
                    if (isNaN(data[column])) {
                        add = false;
                    } else {
                        value = parseFloat(data[column]);
                        rowBuffer[funtionTable[columns[column].type]](value, rowOffset);
                    }
                }
                rowOffset += columns[column].size;
            });

            if (add) {
                rowBuffer.copy(rowsBuffer, offset);
                offset += rowSize;
                ++rowCount;
            }
        }
        progressBar.update(bytesRead);
    });
    progressBar.stop();

    // const rowGetter = getRowGetter(JSON.parse(header), byteBuffer, headerLength + 4);
    // console.log(rowGetter(0));

    const header = JSON.stringify({
        columns,
        order: columnOrder,
        orderOriginal: meta.columnOrder,
        count: rowCount,
        rowSize,
    });
    const headerLength = 4 * Math.floor(header.length / 4) + 4 * Math.min(header.length % 4, 1);
    const headerBuffer = Buffer.alloc(headerLength + 4);

    headerBuffer.writeUInt32LE(headerLength, 0);

    for (let i = 0, n = header.length; i < n; ++i) {
        headerBuffer.writeUInt8(header.charCodeAt(i), 4 + i);
    }

    // 16777216 = 16 MB
    const sizeOf16MB = 16777216;
    const byteLength = rowSize * rowCount;
    const beanCount = Math.ceil(byteLength / sizeOf16MB);
    const beans = [];
    let totalBeanSize = 0;
    let bean;
    let end;
    offset = 0;

    progressBar.start(beanCount, 0, { task: 'Packaging beans' });
    bean = {
        length: headerLength + 4,
        buffer: headerBuffer,
    };
    bean.compressed = pako.deflate(bean.buffer, { level: 9 });
    bean.compressedLength = bean.compressed.length;
    beans.push(bean);
    totalBeanSize += bean.compressedLength;

    for (i = 0; i < beanCount; ++i) {
        end = Math.min(offset + sizeOf16MB, byteLength);
        bean = {
            length: end - offset,
            buffer: rowsBuffer.slice(offset, end),
        };
        bean.compressed = pako.deflate(bean.buffer, { level: 9 });
        bean.compressedLength = bean.compressed.length;
        beans.push(bean);

        totalBeanSize += bean.compressedLength;
        offset += sizeOf16MB;

        progressBar.update(i + 1);
    }
    progressBar.stop();

    /*
     * Bean header format (in Uint32 format)
     * 0: Uncompressed data length in bytes
     * 1: Number of compressed beans
     * N+2: Uncompressed bean size
     * N+3: Compressed bean size
     */
    const beanHeaderSize = 8 + beans.length * 8;
    const beanHeader = new Buffer(beanHeaderSize);
    beanHeader.writeUInt32LE(byteLength + headerLength + 4, 0);
    beanHeader.writeUInt32LE(beans.length, 4);
    for (i = 0; i < beans.length; ++i) {
        beanHeader.writeUInt32LE(beans[i].length, i * 8 + 8);
        beanHeader.writeUInt32LE(beans[i].compressedLength, i * 8 + 12);
    }

    progressBar.start(beanHeaderSize + totalBeanSize, 0, { task: 'Shipping beans' });
    fs.writeFile(output + '.json', header, err => {
        if (err) {
            progressBar.stop();
            console.log(err);
            return;
        }

        const outputStream = fs.createWriteStream(output);
        offset = 0;
        outputStream.write(beanHeader);
        offset += beanHeaderSize;
        progressBar.update(offset);

        for (i = 0; i < beans.length; ++i) {
            outputStream.write(beans[i].compressed);
            offset += beans[i].compressedLength;
            progressBar.update(offset);
        }

        progressBar.stop();
        console.log('DONE!');
    });
}

main(process.argv);
