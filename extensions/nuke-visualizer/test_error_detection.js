function isError(statusMessage) {
    const statusLower = statusMessage.toLowerCase();
    return statusLower.includes('failed') || statusLower.includes('error') || 
           statusLower.includes('unable') || statusLower.includes('unavailable') ||
           statusLower.includes('not found') || statusLower.includes('missing') ||
           statusLower.includes('invalid') || statusLower.includes('timeout') ||
           statusLower.includes('cannot') || statusLower.includes('not responding') ||
           statusLower.includes('no suitable') || statusLower.includes('not installed') ||
           statusLower.includes('cannot find') || statusLower.includes('unexpected');
}

// Test cases
const tests = [
    {msg: 'Unable to find a Python interpreter with both trame and ParaView installed.', expected: true},
    {msg: 'Failed to start server: Error: Unable to find...', expected: true},
    {msg: 'Server not responding after 30s.', expected: true},
    {msg: 'No suitable Python found.', expected: true},
    {msg: 'Starting visualizer server...', expected: false},
    {msg: 'Server ready', expected: false},
    {msg: 'Conversion failed: something', expected: true},
    {msg: 'Invalid path provided', expected: true},
    {msg: 'Module not found', expected: true},
    {msg: 'Timeout after 30 seconds', expected: true},
    {msg: 'Cannot start server', expected: true},
    {msg: 'Unexpected exit', expected: true},
];

let passed = 0;
for (const test of tests) {
    const result = isError(test.msg);
    if (result === test.expected) {
        console.log(`✓ PASS: "${test.msg}" -> ${result}`);
        passed++;
    } else {
        console.log(`✗ FAIL: "${test.msg}" expected ${test.expected} got ${result}`);
    }
}
console.log(`\n${passed}/${tests.length} tests passed`);
