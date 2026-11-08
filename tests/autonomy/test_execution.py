import importlib.util, pathlib, os, copy, socket
import pytest
ROOT=pathlib.Path(__file__).resolve().parents[2]
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'autonomy'/f'{name}.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
runner=load('run');proxy=load('egress')

def test_proxy_refuses_private_dns_and_nonapproved_hosts(monkeypatch):
    monkeypatch.setattr(proxy,'ALLOWED',{'packages.example.com'})
    monkeypatch.setattr(socket,'getaddrinfo',lambda *a,**k:[(socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1',443))])
    with pytest.raises(ValueError,match='non-public'):proxy.destination('packages.example.com',443)
    with pytest.raises(ValueError,match='not permitted'):proxy.destination('metadata.google.internal',80)
    with pytest.raises(ValueError,match='not permitted'):proxy.destination('packages.example.com',2375)

def fixture(tmp_path):
    source=tmp_path/'source';source.mkdir();(source/'calc.py').write_text('def add(a,b):\n    return a+b\n');(source/'test_calc.py').write_text('from calc import add\nassert add(2,3)==5\n')
    p={'version':1,'image':'python:3.12-slim','setup':'','prepare':'','dependency_hosts':[], 'protected_paths':['test_calc.py'],
      'checks':[{'id':'original','title':'Existing behavior','kind':'preserve','script':'python test_calc.py'},
      {'id':'feature','title':'Requested behavior','kind':'requirement','script':'python -c "import calc; assert hasattr(calc, \'subtract\'); assert calc.subtract(9,2)==7"'},
      {'id':'isolation','title':'No test mutation, socket, host or external network access','kind':'preserve','script':'''python - <<'PYCODE'
import pathlib,socket
assert not pathlib.Path('/var/run/docker.sock').exists()
try:
 pathlib.Path('/acceptance/original.sh').write_text('exit 0')
except OSError:pass
else:raise AssertionError('acceptance writable')
for host,port in [('1.1.1.1',443),('host.docker.internal',3100)]:
 try:
  s=socket.create_connection((host,port),timeout=1)
 except OSError:pass
 else:s.close();raise AssertionError('unexpected network access')
PYCODE'''}],
      'mutations':[{'path':'calc.py','find':'return a+b','replace':'return a-b','check_id':'original'}]}
    return source,p

@pytest.mark.skipif(os.environ.get('GOOSE_TEST_DOCKER')!='1',reason='requires Docker')
def test_fresh_execution_detects_mutation_new_behavior_and_isolation(tmp_path):
    source,p=fixture(tmp_path)
    p['setup']="""python - <<'PYCODE'
import socket, urllib.request
for host,port in [('1.1.1.1',443),('host.docker.internal',3100)]:
 try:s=socket.create_connection((host,port),timeout=1)
 except OSError:pass
 else:s.close();raise AssertionError('direct setup egress escaped proxy')
try:urllib.request.urlopen('http://example.com',timeout=3)
except Exception:pass
else:raise AssertionError('unapproved proxy hostname allowed')
PYCODE"""
    baseline=runner.execute(source,p,tmp_path/'baseline','baseline');assert baseline['ok'],baseline
    assert baseline['mutations'][0]['detected']
    (source/'calc.py').write_text('def add(a,b):\n    return a+b\ndef subtract(a,b):\n    return a-b\n')
    candidate=runner.execute(source,p,tmp_path/'candidate','verify');assert candidate['ok'],candidate
    (source/'calc.py').write_text('def add(a,b):\n    return a+b\ndef subtract(a,b):\n    return 999\n')
    broken=runner.execute(source,p,tmp_path/'broken','verify');assert not broken['ok'];assert any(c['id']=='feature' and not c['accepted'] for c in broken['checks'])

@pytest.mark.skipif(os.environ.get('GOOSE_TEST_DOCKER')!='1',reason='requires Docker')
def test_setup_cannot_rewrite_original_tests(tmp_path):
    source,p=fixture(tmp_path);p['setup']="printf 'pass\\n' > test_calc.py"
    r=runner.execute(source,p,tmp_path/'result','baseline');assert not r['ok'];assert 'changed original source' in r['error']
