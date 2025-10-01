import React, {useEffect, useState} from "react";
import {useDispatch, useSelector} from "react-redux";
import {Link} from "react-router-dom";
import { formatDistance } from "date-fns";
import {DataTable} from "primereact/datatable";
import {Column} from "primereact/column";
import {
    subscribeToProjectList,
    unsubscribeFromProjectList
} from "../redux/projectList/actions";
import {Dropdown} from "primereact/dropdown";

export default function ProjectList() {
    const dispatch = useDispatch();

    const projects = useSelector(state => state?.projectList.projectList);
    const isMobile = useSelector(state => state?.window.isMobile);

    const [first, setFirst] = useState(0);
    const [rows, setRows] = useState(10);

    useEffect(() => {
        dispatch(subscribeToProjectList());
        return () => {
            dispatch(unsubscribeFromProjectList());
        }
    }, [dispatch]);

    function formatLinkName(data) {
        return (
            <Link to={`/projects/${data['project_id']}`}>
                {data['title']}
            </Link>
        )
    }

    function lang(data) {
        switch (data.lang) {
            case 'asm':
                return 'Pasmo';
            case 'basic':
                return 'zmakebas';
            case 'bas2tap':
                return 'bas2tap';
            case 'c':
                return 'z88dk zcc';
            case 'sdcc':
                return 'SDDC';
            case 'zmac':
                return 'zmac';
            case 'zxbasic':
                return 'Boriel ZX';
            default:
                throw `unexpected case: ${data.lang}`;
        }
    }

    const now = new Date();

    function formatCreated(data) {
        const date = new Date(data['created_at']);
        return formatDistance(date, now, {addSuffix: true});
    }

    function formatUpdated(data) {
        const date = new Date(data['updated_at']);
        return formatDistance(date, now, {addSuffix: true});
    }

    const onPage = (event) => {
        setFirst(event.first);
        setRows(event.rows);
    }

    const paginatorTemplate = {
        layout: 'RowsPerPageDropdown CurrentPageReport PrevPageLink NextPageLink',
        'RowsPerPageDropdown': (options) => {
            const dropdownOptions = [
                { label: 10, value: 10 },
                { label: 20, value: 20 },
                { label: 50, value: 50 }
            ];

            return (
                <React.Fragment>
                    <span className="mx-1" style={{ color: 'var(--text-color)', userSelect: 'none' }}>Items per page: </span>
                    <Dropdown value={options.value} options={dropdownOptions} onChange={options.onChange} />
                </React.Fragment>
            );
        },
        'CurrentPageReport': (options) => {
            return (
                <span style={{ color: 'var(--text-color)', userSelect: 'none', width: '120px', textAlign: 'center' }}>
                    {options.first} - {options.last} of {options.totalRecords}
                </span>
            )
        }
    };

    if (projects) {
        // Add language title to support sorting.
        for (let i = 0; i < projects.length; i++) {
            const project = projects[i];
            project['lang_title'] = lang(project);
        }
    }

    return (
        <DataTable
            value={projects}
            removableSort
            paginator
            paginatorTemplate={paginatorTemplate}
            first={first}
            rows={rows}
            onPage={onPage}
            paginatorClassName="justify-content-end"
            className="mt-6"
            responsiveLayout="scroll">
            <Column
                field="title"
                header="Project Title"
                body={formatLinkName}
                style={{width: !isMobile ? '34%' : '70%'}}
                sortable
            />
            {!isMobile && (
                <Column
                    field="lang_title"
                    header="Compiler"
                    style={{width: '22%'}}
                    sortable
                />
            )}
            {!isMobile && (
                <Column
                    field="created_at"
                    header="Created"
                    body={formatCreated}
                    style={{width: '22%'}}
                    sortable
                />
            )}
            <Column
                field="updated_at"
                header="Updated"
                body={formatUpdated}
                style={{width: !isMobile ? '22%' : '30%'}}
                sortable
            />
        </DataTable>
    )
}
