import pickle

def load_session(request):
    return pickle.loads(request.data)
