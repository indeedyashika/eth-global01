import http from 'http';

function request(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: JSON.parse(data)
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data
          });
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runTests() {
  const PORT = process.env.PORT || 3000;
  console.log(`Testing simulation provenance against local server on port ${PORT}...`);

  try {
    // 1. Test Rent Simulation
    console.log("1. Testing /api/rent/simulate");
    const rentRes = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/rent/simulate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, JSON.stringify({
      propertyId: "prop_123_test",
      amount: 1000
    }));

    if (rentRes.statusCode !== 200) {
      throw new Error(`Expected 200, got ${rentRes.statusCode}`);
    }
    if (rentRes.data.hcsAudit.txId !== null) {
      throw new Error("Expected hcsAudit.txId to be null for simulated rent");
    }
    console.log("✅ Rent simulation returns null txId");

    // 2. Test Yield Claim Simulation
    console.log("2. Testing /api/yield/claim");
    const yieldRes = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/yield/claim',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, JSON.stringify({
      propertyId: "prop_123_test",
      amount: 100
    }));

    if (yieldRes.statusCode !== 401) {
      throw new Error(`Expected unauthenticated 401, got ${yieldRes.statusCode}`);
    }
    if (yieldRes.data.txId !== null || yieldRes.data.success !== false) {
      throw new Error("Unauthenticated yield claim must not return a transaction or success");
    }
    console.log("✅ Unauthenticated yield claim is rejected with no txId");

    console.log("\nAll simulation provenance tests passed!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Test failed:", err.message);
    process.exit(1);
  }
}

runTests();
