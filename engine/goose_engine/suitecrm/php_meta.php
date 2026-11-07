<?php
/**
 * Goose: read a SuiteCRM 7 installation's configuration and metadata files and print them as JSON,
 * without bootstrapping SuiteCRM or touching its database. Runs inside an isolated container: no network,
 * the customer's files mounted read-only. Secrets in the configuration are replaced by "[redacted]".
 *     php php_meta.php /path/to/suitecrm
 */
error_reporting(E_ERROR | E_PARSE);
define('sugarEntry', true);
$root = rtrim($argv[1], '/');

// Language files call a few SuiteCRM helpers for icons; inert stand-ins keep them readable without bootstrapping.
class GooseInert
{
    public function __call($n, $a) { return ''; }
    public function __get($n) { return ''; }
}
class SugarThemeRegistry
{
    public static function current() { return new GooseInert(); }
    public static function __callStatic($n, $a) { return new GooseInert(); }
}
foreach (array('translate', 'get_image', 'getVersionedPath', 'return_module_language') as $fn) {
    if (!function_exists($fn)) {
        eval("function $fn() { return ''; }");
    }
}
chdir($root);

function load_vars($file, array $seed = array())
{
    if (!is_file($file)) {
        return null;
    }
    extract($seed);
    $sugar_config = isset($sugar_config) ? $sugar_config : array();
    $app_list_strings = isset($app_list_strings) ? $app_list_strings : array();
    $hook_array = array();
    $dictionary = array();
    include $file;
    $vars = get_defined_vars();
    unset($vars['file'], $vars['seed']);
    return $vars;
}

function redact($v, $key = '')
{
    if (is_array($v)) {
        $out = array();
        foreach ($v as $k => $x) {
            $out[$k] = redact($x, (string)$k);
        }
        return $out;
    }
    if (preg_match('/pass|secret|unique_key|private|token|api_key|smtppass/i', $key) && $v !== '' && $v !== null && !is_bool($v)) {
        // a value the sender already replaced (REDACTED, ***, changeme) is reported as such, not as a secret
        return preg_match('/^(\*+|redacted|\[redacted\]|changeme|change_me|xxx+)$/i', (string)$v) ? '[placeholder]' : '[redacted]';
    }
    return $v;
}

$out = array('root' => $root);
$v = load_vars('suitecrm_version.php');
$out['suitecrm_version'] = $v ? $v['suitecrm_version'] : null;
$out['suitecrm_timestamp'] = $v ? $v['suitecrm_timestamp'] : null;
$v = load_vars('sugar_version.php');
$out['sugar_version'] = $v ? $v['sugar_version'] : null;

$cfg = load_vars('config.php');
$config = $cfg ? $cfg['sugar_config'] : array();
$ov = load_vars('config_override.php', array('sugar_config' => $config));
if ($ov) {
    $config = $ov['sugar_config'];
}
$out['config'] = redact($config);
$out['config_override_present'] = is_file('config_override.php');

$lang = load_vars('include/language/en_us.lang.php');
$lists = $lang ? $lang['app_list_strings'] : array();
foreach (array('custom/include/language/en_us.lang.php', 'custom/application/Ext/Language/en_us.lang.ext.php') as $f) {
    $x = load_vars($f, array('app_list_strings' => $lists));
    if ($x) {
        $lists = $x['app_list_strings'];
    }
}
$wanted = array('sales_stage_dom', 'sales_probability_dom', 'lead_status_dom', 'lead_source_dom', 'task_status_dom',
    'task_priority_dom', 'account_type_dom', 'industry_dom', 'opportunity_relationship_type_dom', 'case_status_dom',
    'moduleList', 'record_type_display_notes');
$out['lists'] = array();
foreach ($lists as $k => $x) {
    if (in_array($k, $wanted, true) || !isset($lang['app_list_strings'][$k])) {
        $out['lists'][$k] = $x;
    }
}

// Logic hooks: global, per module, and compiled extension files.
$hooks = array();
$hookFiles = array_merge(glob('custom/modules/logic_hooks.php') ?: array(), glob('custom/modules/*/logic_hooks.php') ?: array(),
    glob('custom/modules/*/Ext/LogicHooks/logichooks.ext.php') ?: array(), glob('custom/application/Ext/LogicHooks/logichooks.ext.php') ?: array());
foreach ($hookFiles as $f) {
    $x = load_vars($f);
    $module = preg_match('#custom/modules/([^/]+)/#', $f, $m) ? $m[1] : '*';
    foreach ((array)($x ? $x['hook_array'] : array()) as $event => $list) {
        foreach ((array)$list as $h) {
            $hooks[] = array('module' => $module, 'event' => $event, 'order' => $h[0], 'label' => $h[1], 'file' => $h[2],
                'class' => $h[3], 'method' => $h[4], 'declared_in' => $f);
        }
    }
}
$out['hooks'] = $hooks;

// Field definitions added through the extension framework (compiled vardefs).
$fields = array();
foreach (glob('custom/modules/*/Ext/Vardefs/vardefs.ext.php') ?: array() as $f) {
    $x = load_vars($f);
    foreach ((array)($x ? $x['dictionary'] : array()) as $object => $def) {
        foreach ((array)(isset($def['fields']) ? $def['fields'] : array()) as $name => $fd) {
            $fields[] = array('object' => $object, 'name' => $name, 'type' => isset($fd['type']) ? $fd['type'] : null,
                'source' => isset($fd['source']) ? $fd['source'] : null, 'declared_in' => $f);
        }
    }
}
$out['ext_fields'] = $fields;

$mods = load_vars('include/modules.php');
$out['module_list'] = $mods && isset($mods['moduleList']) ? array_values($mods['moduleList']) : array();
$out['bean_list'] = $mods && isset($mods['beanList']) ? $mods['beanList'] : array();
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
