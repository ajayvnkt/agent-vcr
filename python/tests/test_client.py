import json
from pathlib import Path
import sys
import tempfile
import unittest
from agent_vcr import Client, ClientError, Recorder

ROOT = Path(__file__).resolve().parents[2]

class ClientTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="vcr ' ; $ test-")
        self.addCleanup(self.tmp.cleanup)
        self.p = Path(self.tmp.name)
        self.client = Client(("node", str(ROOT / "dist/cli.js")))

    def suite(self, calls, policy=None, golden=None):
        recorder = Recorder("sample")
        for name, args in calls: recorder.record(name, args)
        recorder.write(self.p / "trace.json")
        scenario = {"name":"test", "trace":"trace.json"}
        suite = {"version":1,"scenarios":[scenario]}
        if policy is not None:
            (self.p / "policy.json").write_text(json.dumps(policy))
            suite["policy"]="policy.json"
        if golden is not None:
            r = Recorder()
            for name,args in golden:r.record(name,args)
            r.write(self.p/'golden.json');scenario['golden']='golden.json'
        target=self.p/'suite.json';target.write_text(json.dumps(suite));return target

    def test_pass_and_snapshot(self):
        args={'id':1};r=Recorder();r.record('read',args);args['id']=9
        trace=r.write(self.p/'snapshot.json')
        self.assertEqual(json.loads(trace.read_text())['calls'][0]['args']['id'],1)
        with self.assertRaises(FileExistsError):r.write(trace)
        result=self.client.check(self.suite([('read',{'id':1})],golden=[('read',{'id':1})]))
        self.assertTrue(result.passed)

    def test_policy_failure(self):
        r=self.client.check(self.suite([('delete',{})],policy={'forbid':['delete']}))
        self.assertEqual(r.report['counts']['fail'],1);self.assertFalse(r.passed)

    def test_empty_is_error(self):
        r=self.client.check(self.suite([],policy={'forbid':['delete']}))
        self.assertEqual(r.report['counts']['error'],1)

    def test_review_preserved(self):
        suite=self.suite([('read',{})],golden=[('lookup',{})])
        for strict,code in [(True,1),(False,0)]:
            r=self.client.check(suite,strict=strict)
            self.assertEqual(r.exit_code,code);self.assertEqual(r.report['verdict'],'review');self.assertFalse(r.passed)

    def test_missing_and_bad_engine(self):
        suite=self.suite([('read',{})],golden=[('read',{})])
        for command in [('no-such-vcr-executable-xyz',),(sys.executable,'-c','pass')]:
            with self.assertRaises(ClientError):Client(command).check(suite)
        with self.assertRaises(ClientError):self.client.check(self.p/'missing.json')
        with self.assertRaises(ClientError):Client((sys.executable,'-c','import time;time.sleep(10)'),timeout=.03).check(suite)

    def test_arguments_reject(self):
        for arg in [{'a':float('nan')},{1:'bad'},{'a':object()}]:
            with self.assertRaises(ValueError):Recorder().record('tool',arg)
        for arg in [0,-1,float('inf'),True]:
            with self.assertRaises(ValueError):Client(timeout=arg)

    def test_malformed_report_never_passes(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        suite=self.suite([('read',{})],golden=[('read',{})])
        valid=self.client.check(suite).report
        mutations=[lambda d:d.update(version=True), lambda d:d['suite'].update(sha256='0'*64),
                   lambda d:d['suite'].update(path='another.json'), lambda d:d['scenarios'][0].pop('inputs'),
                   lambda d:d.update(scenarios=[{'status':'pass'}])]
        for mutate in mutations:
            report=json.loads(json.dumps(valid));mutate(report)
            def fake(*args):
                out=Path(args[args.index('--out-dir')+1])/'results.json'
                out.write_text(json.dumps(report));return SimpleNamespace(returncode=0)
            with patch.object(self.client,'_run',side_effect=fake), self.assertRaises(ClientError):
                self.client.check(suite)

    def test_otel_existing_reader(self):
        source=ROOT/'examples/check-suite/traces/python-agent.spans.json'
        out=self.client.from_otel(source,self.p/'converted.json')
        self.assertGreater(len(json.loads(out.read_text())['calls']),0)
        with self.assertRaises(FileExistsError):self.client.from_otel(source,out)
        chat=self.p/'chat.json';chat.write_text(json.dumps([{'name':'chat','attributes':{'gen_ai.operation.name':'chat'}}]))
        with self.assertRaises(ClientError):self.client.from_otel(chat,self.p/'no.json')
        self.assertFalse((self.p/'no.json').exists())

if __name__=='__main__':unittest.main()
