import subprocess

def run_command(cmd_args):
    return subprocess.run(cmd_args, check=True)
