import http from 'http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const platformRoot = fs.existsSync(path.join(process.cwd(), 'apps', 'platform'))
  ? path.join(process.cwd(), 'apps', 'platform')
  : process.cwd();

if (!process.env.__TSX_RUNNING__ && !process.execArgv.some((a) => a.includes('tsx'))) {
  const scriptPath = path.join(process.cwd(), 'scripts', 'test-simulation-provenance.mjs');
  const result = spawnSync(
    'npx',
    ['tsx', '--tsconfig', path.join(platformRoot, 'tsconfig.json'), scriptPath],
    {
      stdio: 'inherit',
      cwd: platformRoot,
      env: { ...process.env, NODE_PATH: path.join(platformRoot, 'node_modules'), __TSX_RUNNING__: '1' },
      shell: true,
    }
  );
  process.exit(result.status ?? 0);
}

const { createRequire } = await import('node:module');
const platformRequire = createRequire(path.join(platformRoot, 'package.json'));
const { NextRequest } = await import(pathToFileURL(platformRequire.resolve('next/server')).href);
const rentRoute = await import(pathToFileURL(path.join(platformRoot, 'src', 'app', 'api', 'rent', 'simulate', 'route.ts')).href);
const yieldRoute = await import(pathToFileURL(path.join(platformRoot, 'src', 'app', 'api', 'yield', 'claim', 'route.ts')).href);

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

async function dispatchOrRequest(endpoint, body, port) {
  try {
    const res = await request({
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, JSON.stringify(body));
    return res;
  } catch (err) {
    // Fallback to in-process route execution
    const url = `http://127.0.0.1:${port}${endpoint}`;
    const req = new NextRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    let nextRes;
    if (endpoint === '/api/rent/simulate') {
      nextRes = await rentRoute.POST(req);
    } else if (endpoint === '/api/yield/claim') {
      nextRes = await yieldRoute.POST(req);
    } else {
      throw new Error(`Unhandled endpoint: ${endpoint}`);
    }
    const data = await nextRes.json().catch(() => null);
    return {
      statusCode: nextRes.status,
      headers: Object.fromEntries(nextRes.headers.entries()),
      data
    };
  }
}

async function runTests() {
  const PORT = process.env.PORT || 3000;
  console.log(`Testing simulation provenance (HTTP or direct Next.js route dispatcher)...`);

  try {
    // 1. Test Rent Simulation
    console.log("1. Testing /api/rent/simulate");
    const rentRes = await dispatchOrRequest('/api/rent/simulate', {
      propertyId: "prop_123_test",
      amount: 1000
    }, PORT);

    if (rentRes.statusCode !== 401 && rentRes.statusCode !== 200) {
      throw new Error(`Expected 401 or 200, got ${rentRes.statusCode}`);
    }
    if (rentRes.statusCode === 401) {
      if (rentRes.data?.txId) {
        throw new Error("Expected txId to be null for unauthenticated simulated rent");
      }
      console.log("✅ Unauthenticated rent simulation is rejected with null txId");
    } else {
      if (rentRes.data?.hcsAudit?.txId !== null) {
        throw new Error("Expected hcsAudit.txId to be null for simulated rent");
      }
      console.log("✅ Rent simulation returns null txId");
    }

    // 2. Test Yield Claim Simulation
    console.log("2. Testing /api/yield/claim");
    const yieldRes = await dispatchOrRequest('/api/yield/claim', {
      propertyId: "prop_123_test",
      amount: 100
    }, PORT);

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
