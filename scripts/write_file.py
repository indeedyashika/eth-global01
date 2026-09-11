import sys, base64, os
filepath = sys.argv[1]
b64_content = sys.argv[2]
os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)
with open(filepath, 'wb') as f:
    f.write(base64.b64decode(b64_content))
print(f'Wrote {len(b64_content)} b64 bytes to {filepath}')
