import requests, sys

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:9000'

print('Health:', requests.get(f'{BASE}/healthz').json())
print('Text:', requests.post(f'{BASE}/embed/text', json={'text':'hello world paris'}).json())
