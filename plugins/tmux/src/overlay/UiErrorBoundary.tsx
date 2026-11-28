import { Component, type ReactNode } from "react";
import { toast } from "sonner";
import { getUiState, subscribeUiState, updateUiState } from "../bridge";
import { PLUGIN_ID } from "../constants";
import { settleDomFocus } from "../pane-focus";
import { NOTICE_TOAST_ID } from "./Notices";

interface UiErrorBoundaryProps {
  children: ReactNode;
}

interface UiErrorBoundaryState {
  hasCrashed: boolean;
}

function reportCrash(error: unknown): void {
  console.error(`[${PLUGIN_ID}] the popup interface crashed`, error);
  try {
    toast.error("Tmux keys: a popup failed to open. See the console.", {
      id: NOTICE_TOAST_ID,
    });
  } catch (toastError) {
    console.error(`[${PLUGIN_ID}] showing the crash notice failed`, toastError);
  }
}

// A popup that crashes while it is open takes the element that held the
// cursor with it, and what the cursor was on before is lost with the popup.
// A cursor that is left on nothing goes to the focused pane.
function rescueCursor(): void {
  const active = document.activeElement;
  if (active !== null && active !== document.body) return;
  try {
    settleDomFocus();
  } catch (error) {
    console.error(`[${PLUGIN_ID}] placing the cursor after the crash failed`, error);
  }
}

export class UiErrorBoundary extends Component<
  UiErrorBoundaryProps,
  UiErrorBoundaryState
> {
  state: UiErrorBoundaryState = { hasCrashed: false };

  private stopWaitingForRetry: (() => void) | null = null;

  static getDerivedStateFromError(): UiErrorBoundaryState {
    return { hasCrashed: true };
  }

  componentDidCatch(error: unknown): void {
    reportCrash(error);
    const { chooser, helpOpen } = getUiState();
    updateUiState({ chooser: { open: false }, helpOpen: false });
    if (chooser.open || helpOpen) rescueCursor();
    this.stopWaitingForRetry?.();
    this.stopWaitingForRetry = subscribeUiState(this.retry);
  }

  componentWillUnmount(): void {
    this.stopWaitingForRetry?.();
  }

  private retry = (): void => {
    this.stopWaitingForRetry?.();
    this.stopWaitingForRetry = null;
    this.setState({ hasCrashed: false });
  };

  render(): ReactNode {
    return this.state.hasCrashed ? null : this.props.children;
  }
}
