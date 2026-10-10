import { Anchor, Badge, Box, Group, Text, type BoxProps } from "@mantine/core";
const workhorseMarkUrl = new URL("./assets/workhorse-mark.svg", import.meta.url).href;
const workhorseWordmarkUrl = new URL("./assets/workhorse-wordmark.svg", import.meta.url).href;

interface WorkhorseMarkProps extends BoxProps {
  label?: string;
}

function WorkhorseMark({ label = "Workhorse", ...props }: WorkhorseMarkProps) {
  return <Box component="img" src={workhorseMarkUrl} alt={label} {...props} />;
}

export function WorkhorseBrand() {
  return (
    <Group gap={6} wrap="nowrap" className="workhorse-brand">
      <Box className="workhorse-brand__mark" aria-hidden="true">
        <WorkhorseMark label="" w={38} h={38} />
      </Box>
      <Box
        component="img"
        src={workhorseWordmarkUrl}
        alt="Workhorse"
        className="workhorse-brand__wordmark"
      />
    </Group>
  );
}

/** Commit pages for the source revision a build names. */
const workhorseCommitUrl = "https://github.com/stablemates/workhorse/commit/";

export function WorkhorseVersion({ version, revision }: { version?: string; revision?: string }) {
  return (
    <Group w="100%" justify="space-between" gap="xs" wrap="nowrap">
      <Badge variant="light" color="gray" size="xs">
        Public beta
      </Badge>
      {version === undefined ? null : (
        <Group gap={4} wrap="nowrap">
          <Text
            component="span"
            size="10px"
            c="dimmed"
            ff="monospace"
            aria-label={`Workhorse version ${version}`}
          >
            v{version}
          </Text>
          {revision === undefined ? null : (
            <Anchor
              href={`${workhorseCommitUrl}${revision}`}
              target="_blank"
              rel="noreferrer"
              size="10px"
              c="dimmed"
              ff="monospace"
              aria-label={`Workhorse revision ${revision}`}
              title={revision}
            >
              {revision.slice(0, 7)}
            </Anchor>
          )}
        </Group>
      )}
    </Group>
  );
}
