import { Box, Text } from "ink";
import type { Task, TaskStatus } from "@orchestrator/types";

const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: "gray",
  running: "yellow",
  completed: "green",
  failed: "red",
  blocked: "blue",
  conflicted: "magenta",
};

interface DashboardProps {
  tasks: Task[];
  currentWave: number;
  totalWaves: number;
  onSelectTask?: (taskId: string) => void;
}

/**
 * Dashboard — the main TUI view showing all sessions, their statuses,
 * streaming logs, and the current wave. The user can select any running
 * session to Attach to it.
 */
export function Dashboard({ tasks, currentWave, totalWaves, onSelectTask }: DashboardProps) {
  const groupedByWave = groupByWave(tasks);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Agent Orchestrator</Text>
        <Text> — Wave {currentWave + 1} of {totalWaves}</Text>
      </Box>

      {groupedByWave.map((waveTasks, waveNum) => (
        <Box key={waveNum} flexDirection="column" marginBottom={1}>
          <Text bold color={waveNum === currentWave ? "cyan" : "gray"}>
            Wave {waveNum + 1}
            {waveNum === currentWave ? " (active)" : ""}
          </Text>
          {waveTasks.map((task) => (
            <TaskRow key={task.id} task={task} onSelect={onSelectTask} />
          ))}
        </Box>
      ))}
    </Box>
  );
}

function TaskRow({ task }: { task: Task; onSelect?: (id: string) => void }) {
  return (
    <Box>
      <Text color={STATUS_COLORS[task.status]}>●</Text>
      <Text> {task.title}</Text>
      <Text dimColor> [{task.adapter}]</Text>
      {task.sizeWarning && <Text color="yellow"> ⚠ {task.sizeWarning}</Text>}
      {task.prUrl && <Text dimColor> PR: {task.prUrl}</Text>}
    </Box>
  );
}

function groupByWave(tasks: Task[]): Task[][] {
  const maxWave = Math.max(...tasks.map((t) => t.wave), 0);
  const waves: Task[][] = Array.from({ length: maxWave + 1 }, () => []);
  for (const task of tasks) {
    waves[task.wave].push(task);
  }
  return waves;
}
