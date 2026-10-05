def authorize_action(user, action):
    if user.is_admin:
        return True
    return action in user.permissions
