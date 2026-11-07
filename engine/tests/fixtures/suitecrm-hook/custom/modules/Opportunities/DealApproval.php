<?php
/**
 * TEST FIXTURE: a custom approval rule (not part of standard SuiteCRM).
 *
 * Business rule: a salesperson cannot mark a deal worth more than $25,000 as "Closed Won"
 * until a sales manager of the same team has approved it.
 *
 *  - The threshold is compared with the deal's US-dollar value (amount_usdollar), so a deal
 *    entered in euros is converted first.
 *  - Only a user with the "Sales Manager" role who shares a security group (team) with the
 *    deal's assigned salesperson, or an administrator, can set the approval to Approved or
 *    Rejected. Anyone can request approval.
 *  - Approving records who approved, when, and the US-dollar amount approved. Raising the
 *    amount above the approved amount withdraws the approval (back to Requested).
 *  - A blocked "Closed Won" keeps the previous stage, sets the approval to Requested and
 *    shows a message.
 *
 * Runs as a before_save logic hook, so it applies to the edit view, inline edit, mass update,
 * imports and the API alike.
 *
 * Test fixture for the SuiteCRM inspection. Licensed like SuiteCRM, AGPLv3.
 */
if (!defined('sugarEntry') || !sugarEntry) {
    die('Not A Valid Entry Point');
}

require_once 'modules/ACLRoles/ACLRole.php';
require_once 'modules/SecurityGroups/SecurityGroup.php';

class DealApproval
{
    const THRESHOLD_USD = 25000;
    const WON_STAGE = 'Closed Won';
    const MANAGER_ROLE = 'Sales Manager';

    public function beforeSave($bean, $event, $arguments)
    {
        global $current_user;

        $before = (isset($bean->fetched_row) && is_array($bean->fetched_row)) ? $bean->fetched_row : array();
        $oldStatus = isset($before['approval_status_c']) ? (string)$before['approval_status_c'] : '';
        $oldStage = isset($before['sales_stage']) ? (string)$before['sales_stage'] : '';
        $status = isset($bean->approval_status_c) ? (string)$bean->approval_status_c : '';
        $usd = (float)$bean->amount_usdollar;

        // 1. Only a manager of the deal's team (or an administrator) may approve or reject.
        if ($status !== $oldStatus && in_array($status, array('approved', 'rejected'), true)
            && !$this->isTeamManager($current_user, $bean)) {
            $status = $oldStatus;
            SugarApplication::appendErrorMessage('Only a sales manager on this team can approve or reject a deal.');
        }

        // 2. Record the approval.
        if ($status === 'approved' && $oldStatus !== 'approved') {
            $bean->approved_amount_c = $usd;
            $bean->user_id_c = $current_user->id;
            $bean->approved_at_c = TimeDate::getInstance()->nowDb();
        }

        // 3. An approval covers the amount that was approved, not more.
        if ($status === 'approved' && $usd > (float)$bean->approved_amount_c + 0.005) {
            $status = 'requested';
            SugarApplication::appendErrorMessage('The amount is now above the approved amount, so the approval was withdrawn.');
        }

        // 4. Closing as won above the threshold needs a current approval.
        if ($bean->sales_stage === self::WON_STAGE && $oldStage !== self::WON_STAGE
            && $usd > self::THRESHOLD_USD && $status !== 'approved') {
            $bean->sales_stage = $oldStage !== '' ? $oldStage : 'Negotiation/Review';
            if ($status === '' || $status === 'rejected') {
                $status = 'requested';
            }
            SugarApplication::appendErrorMessage(
                'Deals above $25,000 need approval from a sales manager before they can be marked Closed Won. Approval has been requested.'
            );
        }

        $bean->approval_status_c = $status;
    }

    /** A "Sales Manager" who shares a security group (team) with the deal's assigned user, or an administrator. */
    private function isTeamManager($user, $bean)
    {
        if (empty($user) || empty($user->id)) {
            return false;
        }
        if ($user->isAdmin()) {
            return true;
        }
        $role = new ACLRole();
        if (!in_array(self::MANAGER_ROLE, (array)$role->getUserRoleNames($user->id), true)) {
            return false;
        }
        $assigned = !empty($bean->assigned_user_id) ? $bean->assigned_user_id : $user->id;
        $managerTeams = array_keys((array)SecurityGroup::getUserSecurityGroups($user->id));
        $sellerTeams = array_keys((array)SecurityGroup::getUserSecurityGroups($assigned));
        return count(array_intersect($managerTeams, $sellerTeams)) > 0;
    }
}
