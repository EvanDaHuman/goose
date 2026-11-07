import heapq
import json
import sys

def plan(request):
    nodes = request.get("nodes", [])
    start, end = request.get("start"), request.get("end")
    if start not in nodes or end not in nodes:
        return {"error": "unknown node"}
    graph = {node: [] for node in nodes}
    for a, b, weight in request.get("edges", []):
        if a not in graph or b not in graph or not isinstance(weight, (int, float)) or weight < 0:
            return {"error": "invalid edge"}
        graph[a].append((b, weight))
        graph[b].append((a, weight))
    queue = [(0, [start], start)]
    best = {}
    while queue:
        distance, route, node = heapq.heappop(queue)
        if node in best:
            continue
        best[node] = distance
        if node == end:
            return {"distance": distance, "route": route}
        for neighbor, weight in sorted(graph[node]):
            if neighbor not in best:
                heapq.heappush(queue, (distance + weight, route + [neighbor], neighbor))
    return {"distance": None, "route": []}

if __name__ == "__main__":
    try:
        print(json.dumps(plan(json.load(sys.stdin)), ensure_ascii=False))
    except (ValueError, TypeError, KeyError):
        print(json.dumps({"error": "invalid request"}))
