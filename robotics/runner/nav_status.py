"""Interpret Nav2 action-server completion independently of candidate counters."""


def navigator_publisher(info,endpoints):
    identifier=info.get("publisher_gid") if isinstance(info,dict) else getattr(info,"publisher_gid",None)
    if identifier is None:
        # Jazzy exposes timestamp-only MessageInfo. Accept discovery only when
        # Nav2 is the sole publisher; a separate GetResult RPC proves success.
        if len(endpoints)==1 and endpoints[0].node_name=="bt_navigator":
            return endpoints[0].node_namespace.rstrip("/")+"/bt_navigator"
        return None
    if not any(identifier):return None
    for endpoint in endpoints:
        if endpoint.node_name=="bt_navigator" and bytes(endpoint.endpoint_gid)==bytes(identifier):
            return endpoint.node_namespace.rstrip("/")+"/"+endpoint.node_name
    return None


def successful_goal_ids(statuses, publisher_is_navigator=False):
    if not publisher_is_navigator:
        return set()
    succeeded=set()
    for status in statuses:
        identifier=bytes(status.goal_info.goal_id.uuid)
        if status.status==4 and len(identifier)==16 and any(identifier):
            succeeded.add(identifier.hex())
    return succeeded
