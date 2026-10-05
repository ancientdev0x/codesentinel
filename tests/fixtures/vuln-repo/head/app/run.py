import subprocess

def run_ping(host):
    cmd = f"ping -c 1 {host}"
    return subprocess.call(cmd, shell=True)
