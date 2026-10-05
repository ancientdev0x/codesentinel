import json

def load_session(request):
    return json.loads(request.data)
