"""
Background thread that monitors and kills long-running compilation processes.
Runs as part of the FastAPI application.
"""
import os
import time
import signal
import threading
import subprocess
from datetime import datetime

# Configuration
MAX_PROCESS_AGE = 8  # Kill compilation processes older than 8 seconds
CHECK_INTERVAL = 2   # Check every 2 seconds


class ProcessMonitor:
    def __init__(self):
        self.running = False
        self.thread = None
        self.processes = {}  # Track subprocess PIDs we start

    def register_process(self, pid):
        """Register a compilation process to monitor"""
        self.processes[pid] = time.time()
        print(f"[MONITOR] Tracking compilation process PID {pid}")

    def start(self):
        """Start the monitor thread"""
        if not self.running:
            self.running = True
            self.thread = threading.Thread(target=self._monitor_loop, daemon=True)
            self.thread.start()
            print("[MONITOR] Process monitor started")

    def stop(self):
        """Stop the monitor thread"""
        self.running = False

    def _monitor_loop(self):
        """Main monitoring loop that runs in background"""
        while self.running:
            try:
                current_time = time.time()
                pids_to_remove = []

                # Check tracked processes
                for pid, start_time in list(self.processes.items()):
                    age = current_time - start_time

                    try:
                        # Check if process still exists
                        os.kill(pid, 0)  # Signal 0 just checks if process exists

                        if age > MAX_PROCESS_AGE:
                            print(f"[MONITOR] Killing stuck process PID {pid} (age: {age:.1f}s)")
                            try:
                                # Try graceful termination first
                                os.kill(pid, signal.SIGTERM)
                                time.sleep(0.5)
                                # Check if still alive
                                os.kill(pid, 0)
                                # If still alive, force kill
                                os.kill(pid, signal.SIGKILL)
                                print(f"[MONITOR] Force killed PID {pid}")
                            except OSError:
                                pass  # Process already dead
                            pids_to_remove.append(pid)

                    except OSError:
                        # Process doesn't exist anymore
                        pids_to_remove.append(pid)

                # Clean up dead processes from tracking
                for pid in pids_to_remove:
                    del self.processes[pid]

                # Also check for any zxbc processes we didn't start
                # (in case of threading issues)
                self._check_orphan_processes()

            except Exception as e:
                print(f"[MONITOR] Error in monitor loop: {e}")

            time.sleep(CHECK_INTERVAL)

    def _check_orphan_processes(self):
        """Check for compilation processes we might not be tracking"""
        try:
            # Use ps to find zxbc processes
            result = subprocess.run(
                ["ps", "aux"],
                capture_output=True,
                text=True,
                timeout=1
            )

            for line in result.stdout.split('\n'):
                # The app only ever spawns the zxbc compiler for compilation, so
                # match on the executable name rather than specific flags. The
                # zxbasic console script appears in ps as ".../bin/zxbc".
                if 'zxbc' in line:
                    parts = line.split()
                    if len(parts) > 1:
                        pid = int(parts[1])
                        # If we're not tracking this PID, it might be orphaned
                        if pid not in self.processes:
                            # Check process age using /proc if available
                            try:
                                stat_path = f"/proc/{pid}/stat"
                                if os.path.exists(stat_path):
                                    with open(stat_path, 'r') as f:
                                        stat_data = f.read().split()
                                        # Field 21 is start time in jiffies
                                        start_jiffies = int(stat_data[21])
                                        # Rough age calculation
                                        age_seconds = (time.time() - os.path.getmtime(stat_path))
                                        if age_seconds > MAX_PROCESS_AGE:
                                            print(f"[MONITOR] Found orphan zxbc process PID {pid}, killing...")
                                            os.kill(pid, signal.SIGKILL)
                            except:
                                pass
        except:
            pass  # PS might not be available or fail


# Global monitor instance
process_monitor = ProcessMonitor()