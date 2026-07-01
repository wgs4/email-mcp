#!/usr/bin/env bash
# Deploy email-mcp to k3s cluster
# Usage: ./deploy.sh [--copy-config]
#
# Prerequisites:
#   - kubectl with ~/.kube/qnap-k3s
#   - email-mcp image built and pushed (tag email-mcp-v0.4.0)
#   - ghcr-pull-secret in namespace mcp

set -euo pipefail

KUBECONFIG="${KUBECONFIG:-$HOME/.kube/qnap-k3s}"
NAMESPACE="mcp"
CHART_DIR="${CHART_DIR:-$(cd "$(dirname "$0")/../mcp-setup/charts/email-mcp" && pwd)}"
CONFIG_SRC="${CONFIG_SRC:-$HOME/.config/email-mcp/config.toml}"
export KUBECONFIG

echo "=== email-mcp Deploy ==="

# Ensure namespace and image pull secret exist
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# Deploy via Helm
helm upgrade --install email-mcp "$CHART_DIR" \
  --namespace "$NAMESPACE" \
  --create-namespace

# Copy local config into PVC if requested
if [[ "${1:-}" == "--copy-config" ]]; then
  if [[ ! -f "$CONFIG_SRC" ]]; then
    echo "ERROR: Config not found at $CONFIG_SRC"
    exit 1
  fi

  echo "Copying config.toml into PVC..."

  # Wait for PVC to be bound
  PVC_NAME=$(kubectl get pvc -n "$NAMESPACE" -l app.kubernetes.io/name=email-mcp -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [[ -z "$PVC_NAME" ]]; then
    echo "Waiting for PVC..."
    sleep 5
    PVC_NAME=$(kubectl get pvc -n "$NAMESPACE" -l app.kubernetes.io/name=email-mcp -o jsonpath='{.items[0].metadata.name}')
  fi
  echo "PVC: $PVC_NAME"

  # Copy config via temp pod
  kubectl run email-mcp-config-copy \
    --namespace "$NAMESPACE" \
    --image=busybox \
    --restart=Never \
    --overrides='{
      "spec": {
        "containers": [{
          "name": "config-copy",
          "image": "busybox",
          "command": ["sh", "-c", "sleep 3600"],
          "volumeMounts": [{
            "name": "config",
            "mountPath": "/config"
          }]
        }],
        "volumes": [{
          "name": "config",
          "persistentVolumeClaim": {"claimName": "'"$PVC_NAME"'"}
        }]
      }
    }'

  echo "Waiting for config-copy pod..."
  kubectl wait --for=condition=Ready pod/email-mcp-config-copy -n "$NAMESPACE" --timeout=60s

  # Copy config into PVC
  kubectl cp "$CONFIG_SRC" "$NAMESPACE/email-mcp-config-copy:/config/config.toml"

  # Cleanup
  kubectl delete pod email-mcp-config-copy -n "$NAMESPACE"

  echo "Config copied."
fi

# Restart email-mcp to pick up config
kubectl rollout restart deployment -n "$NAMESPACE" -l app.kubernetes.io/name=email-mcp

echo "=== Waiting for rollout ==="
kubectl rollout status deployment -n "$NAMESPACE" -l app.kubernetes.io/name=email-mcp --timeout=120s

echo "=== Status ==="
kubectl get pods,ingress,certificate -n "$NAMESPACE" -l app.kubernetes.io/name=email-mcp

echo ""
echo "=== Done ==="
echo "Endpoint: https://email-mcp.mcp.glue-it.de"
echo "Health:   https://email-mcp.mcp.glue-it.de/health"
echo ""
echo "To add accounts interactively:"
echo "  kubectl exec -it -n $NAMESPACE deploy/email-mcp -- node dist/main.js account add"
echo ""
echo "To view config:"
echo "  kubectl exec -it -n $NAMESPACE deploy/email-mcp -- cat /home/node/.config/email-mcp/config.toml"